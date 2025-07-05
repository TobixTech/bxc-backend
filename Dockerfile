# Use the official Node.js 18 (LTS) image as the base
FROM node:18-slim

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json (if exists)
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of the application code
COPY . .

# Expose the port your app will listen on (Fly.io will map this)
EXPOSE 5000

# Command to run the application
CMD ["node", "index.js"]
