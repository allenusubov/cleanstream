import test from 'node:test';
import assert from 'node:assert/strict';
import {eventCategory,loadEventPreferences,setEventCategoryEnabled,setEventCategoryOrder,setEventFavorites,tickerEvents,compactEventTitle} from '../public/event-preferences.js';

function memory(initial=''){
  let value=initial;
  return {getItem(){return value||null;},setItem(_k,next){value=next;},dump(){return value;}};
}

test('event categories collapse soccer and tennis leagues into display categories',()=>{
  assert.equal(eventCategory({sport:'soccer',league:'EPL'}),'SOCCER');
  assert.equal(eventCategory({sport:'tennis',league:'ATP'}),'TENNIS');
  assert.equal(eventCategory({sport:'basketball',league:'NBA'}),'NBA');
});

test('event display preferences persist toggles, order and favorites',()=>{
  const storage=memory();
  setEventCategoryEnabled('NHL',false,storage);
  setEventCategoryOrder(['UFC','NBA','NFL'],storage);
  setEventFavorites(['New York Knicks','Jon Jones'],storage);
  const prefs=loadEventPreferences(storage);
  assert.deepEqual(prefs.categories.slice(0,3).map(x=>x.key),['UFC','NBA','NFL']);
  assert.equal(prefs.categories.find(x=>x.key==='NHL').enabled,false);
  assert.deepEqual(prefs.favorites,['New York Knicks','Jon Jones']);
});

test('ticker keeps live and showtime first while preferences break same-time ties',()=>{
  const prefs={categories:[
    {key:'UFC',enabled:true},{key:'NBA',enabled:true},{key:'NHL',enabled:false}
  ],favorites:['Knicks']};
  const same='2026-10-05T23:00:00Z';
  const events=[
    {title:'OTHER FIGHT',status:'scheduled',startTime:same,sport:'mma',league:'UFC'},
    {title:'NEW YORK KNICKS VS BOSTON CELTICS',status:'scheduled',startTime:same,sport:'basketball',league:'NBA'},
    {title:'RANGERS VS DEVILS',status:'scheduled',startTime:'2026-10-05T22:00:00Z',sport:'hockey',league:'NHL'},
    {title:'LIVE NBA',status:'live',startTime:'2026-10-05T20:00:00Z',sport:'basketball',league:'NBA'}
  ];
  const out=tickerEvents(events,prefs);
  assert.deepEqual(out.map(x=>x.title),['LIVE NBA','NEW YORK KNICKS VS BOSTON CELTICS','OTHER FIGHT']);
});


test('compact ticker title prefers ESPN short team names',()=>{
  const event={title:'Tampa Bay Lightning VS Philadelphia Flyers',participants:[{name:'Tampa Bay Lightning',shortName:'Lightning'},{name:'Philadelphia Flyers',shortName:'Flyers'}]};
  assert.equal(compactEventTitle(event),'Lightning VS Flyers');
});

test('compact ticker title keeps non-matchup event title',()=>{
  assert.equal(compactEventTitle({title:'FORMULA 1 JAPANESE GRAND PRIX',participants:[]}), 'FORMULA 1 JAPANESE GRAND PRIX');
});
