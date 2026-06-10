FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build Vite frontend
RUN npm run build

# Create data directory
RUN mkdir -p /app/data/images

# Expose HTTP port
EXPOSE 3000

# Environment variables
ENV PORT=3000
ENV TRANSPORT=sse
ENV NODE_ENV=production

# Start server
CMD ["npx", "tsx", "src/index.ts"]
