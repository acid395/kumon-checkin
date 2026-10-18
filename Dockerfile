FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
ENV PORT=8787 HOST=0.0.0.0
EXPOSE 8787
# Mount a volume at /app/data to keep students and attendance across restarts.
VOLUME ["/app/data"]
CMD ["node", "server.js"]
