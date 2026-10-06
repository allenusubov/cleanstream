import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCustomSource,loadCustomSources,setCustomSourceProfile,parseProfileLines,recordCustomSourceSuccess,KNOWN_CATEGORIES
} from '../public/custom-sources.js';
import {profileFromLinks} from '../lib/source-profile.js';
import {tmdbSearchQuery,normalizeMovie,normalizeTv,normalizeEpisode} from '../lib/tmdb.js';

const storage=()=>{const data=new Map();return {getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)};};

test('TVM custom sources support TV, MOVIES, and reusable search routes',()=>{
  assert.ok(KNOWN_CATEGORIES.includes('TV'));
  assert.ok(KNOWN_CATEGORIES.includes('MOVIES'));
  const s=storage();addCustomSource('example.com',s);
  const parsed=parseProfileLines('TV /tv\nMOVIES /movies\nSEARCH /search?q={query}','https://example.com/');
  assert.equal(parsed.invalid,0);
  setCustomSourceProfile('https://example.com/',parsed,s);
  const item=loadCustomSources(s)[0];
  assert.equal(item.support.TV,'YES');
  assert.equal(item.support.MOVIES,'YES');
  assert.equal(item.categories.TV[0],'https://example.com/tv');
  assert.equal(item.categories.MOVIES[0],'https://example.com/movies');
  assert.match(decodeURIComponent(item.structure.searchTemplates[0]),/\{query\}/);
});

test('site learning recognizes reusable TV and movie navigation',()=>{
  const profile=profileFromLinks([
    {url:'https://example.com/tv',text:'TV Shows'},
    {url:'https://example.com/movies',text:'Movies'},
    {url:'https://example.com/live',text:'Live Events'}
  ],'https://example.com/',['https://example.com/search?q={query}']);
  assert.equal(profile.support.TV,'YES');
  assert.equal(profile.support.MOVIES,'YES');
  assert.equal(profile.categories.TV[0],'https://example.com/tv');
  assert.equal(profile.categories.MOVIES[0],'https://example.com/movies');
  assert.equal(profile.structure.searchTemplates[0],'https://example.com/search?q={query}');
});

test('TMDB helpers normalize show, movie, season, episode metadata',()=>{
  assert.equal(tmdbSearchQuery('Breaking Bad season 2 episode 3'),'Breaking Bad');
  const show=normalizeTv({id:1396,name:'Breaking Bad',first_air_date:'2008-01-20'},{number_of_seasons:5});
  assert.equal(show.title,'Breaking Bad');assert.equal(show.year,2008);assert.equal(show.seasonCount,5);
  const movie=normalizeMovie({id:949,title:'Heat',release_date:'1995-12-15'});
  assert.equal(movie.title,'Heat');assert.equal(movie.year,1995);assert.equal(movie.kind,'movie');
  const episode=normalizeEpisode(show,1,{episode_number:1,name:'Pilot',air_date:'2008-01-20'});
  assert.equal(episode.seasonNumber,1);assert.equal(episode.episodeNumber,1);assert.equal(episode.airDate,'2008-01-20');assert.match(episode.title,/PILOT/);
});


test('TVM source learning persists browser search and reusable episode templates',()=>{
  const s=storage();addCustomSource('example.com',s);
  recordCustomSourceSuccess('https://example.com/',320,{structure:{browserSearch:true,searchTemplates:['https://example.com/search?q={query}'],episodeTemplates:['https://example.com/show/{title}-season-{season}-episode-{episode}/']}},s);
  const item=loadCustomSources(s)[0];
  assert.equal(item.structure.browserSearch,true);
  assert.equal(item.structure.searchTemplates[0],'https://example.com/search?q={query}');
  assert.equal(item.structure.episodeTemplates[0],'https://example.com/show/{title}-season-{season}-episode-{episode}/');
});

test('site learning can remember a browser search UI even without a reusable GET route',()=>{
  const profile=profileFromLinks([{url:'https://example.com/tv',text:'TV Shows'}],'https://example.com/',[],true);
  assert.equal(profile.structure.browserSearch,true);
});

test('site learning treats TV Series / Shows / Television as TV navigation and rejects title-page false positives',()=>{
  const profile=profileFromLinks([
    {url:'https://example.com/tv-series',text:'TV Series'},
    {url:'https://example.com/shows?page=2',text:'Shows'},
    {url:'https://example.com/movies',text:'Films'},
    {url:'https://example.com/show/207347-blue-box',text:'Blue Box'},
    {url:'https://example.com/movie/9012-jackass-the-movie',text:'Jackass: The Movie'},
    {url:'https://example.com/watch/show/22980-watch-what-happens-live-with-andy-cohen/1/1',text:'Watch What Happens Live with Andy Cohen'}
  ],'https://example.com/');
  assert.ok(profile.categories.TV.includes('https://example.com/tv-series'));
  assert.ok(profile.categories.TV.includes('https://example.com/shows'));
  assert.equal(profile.categories.BOXING?.some(url=>url.includes('blue-box'))||false,false);
  assert.equal(profile.categories.MOVIES.some(url=>url.includes('jackass-the-movie')),false);
  assert.equal(profile.categories.TV.some(url=>url.includes('andy-cohen')),false);
});
