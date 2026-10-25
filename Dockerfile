FROM node:24-alpine
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY package.json server.js importer.js ./
COPY public ./public
# Run as the unprivileged "node" user; only the data folder is writable.
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8787
# Mount a volume at /app/data to keep students and attendance across restarts and updates.
VOLUME ["/app/data"]
CMD ["node", "server.js"]
