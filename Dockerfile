FROM node:18-alpine

# Set the working directory
WORKDIR /usr/src/app

# Runtime libs required by node-canvas (cairo/pango/jpeg/etc).
RUN apk add --no-cache \
        cairo jpeg pango giflib pixman libjpeg-turbo freetype

# Copy package.json and package-lock.json
COPY package*.json ./

# Build deps for native modules (canvas), removed after install.
RUN apk add --no-cache --virtual .build-deps \
        build-base python3 g++ \
        cairo-dev jpeg-dev pango-dev giflib-dev pixman-dev libjpeg-turbo-dev freetype-dev \
    && npm install --only=production \
    && apk del .build-deps

# Copy the rest of the application code
COPY . .

# Expose the port the app runs on
EXPOSE 3000

# Define the command to run the application
CMD ["npm", "start"]
