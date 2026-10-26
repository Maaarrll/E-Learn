# Small official Node image; pinned major so rebuilds don't jump versions
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Production dependencies only, exactly as locked
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Files stay owned by root, so the app user can read but never change the code
COPY . .

# Run as the image's unprivileged user, not root
USER node

EXPOSE 3000
CMD ["node", "server.js"]
