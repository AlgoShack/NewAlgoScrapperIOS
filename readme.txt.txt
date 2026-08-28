Install packages
npm install

Start the applictaion
npm start


npm run make

npm run make -- --platform win32
npm run make -- --platform linux
npm run make -- --platform darwin

to build installer use this
rm -rf algoScraper-darwin-arm64

npx electron-packager . algoScraper \
--platform=darwin \
--arch=arm64 \
--overwrite


added auto app detection and bundleId selector