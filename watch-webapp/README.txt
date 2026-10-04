CLEANSTREAM TIMEOUT FIX

Replace:
1. watch-webapp/server.js
2. watch-webapp/public/app.js

This fixes:
- pages that never finish DOMContentLoaded
- popup tabs during automatic player startup
- slow image/font loading
- players that only request media after Play is triggered
- HTML error pages being shown as 'Unexpected token < ... not valid JSON'
