FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Fail the build if the matching extraction browser cannot start.
RUN node --input-type=module -e "import {chromium} from 'playwright'; const browser=await chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}); await browser.close();"

COPY . .

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["npm", "start"]
