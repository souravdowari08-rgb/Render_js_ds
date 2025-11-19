FROM node:20-slim

# Install dependencies for Chromium
RUN apt-get update && apt-get install -y \
    wget ca-certificates fonts-liberation libnss3 lsb-release libatk-bridge2.0-0 libatk1.0-0 libcups2 libxcomposite1 libxrandr2 \
    libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 libasound2 libxss1 libxtst6 libglib2.0-0 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create app dir
WORKDIR /app
COPY package.json /app/
# install deps (puppeteer will download chromium)
RUN npm install --production

# copy source
COPY . /app

# expose port
ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "node server.js"]
