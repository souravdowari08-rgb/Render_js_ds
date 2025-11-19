FROM node:20-bullseye

# Install system dependencies required by Playwright (Firefox)
RUN apt-get update && apt-get install -y \
    wget ca-certificates libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libxcomposite1 libxrandr2 \
    libxdamage1 libxkbcommon0 libpango-1.0-0 libcairo2 libasound2 libxss1 libxtst6 libglib2.0-0 libgtk-3-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json /app/

# Install dependencies (Playwright will download its browsers)
RUN npm install --production

# Install Playwright Firefox with dependencies
RUN npx playwright install --with-deps firefox

# Copy app source
COPY . /app

ENV PORT=10000
EXPOSE 10000

CMD ["sh", "-c", "node server.js"]
