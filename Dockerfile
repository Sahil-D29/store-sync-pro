FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production
RUN npm remove @shopify/cli

# Copy source
COPY . .

# Generate Prisma client
RUN npx prisma generate

# Build the app
RUN npm run build

# Default: start web server (overridden by fly.toml for worker process)
CMD ["npm", "run", "docker-start"]
