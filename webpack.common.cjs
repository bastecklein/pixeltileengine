const path = require("path");

module.exports = {
    entry: "./src/index.js",
    output: {
        filename: "pixeltileengine.js",
        path: path.resolve(__dirname, "dist"),
        library: {
            type: "module"
        }
    },
    experiments: {
        outputModule: true
    },
    mode: "production"
};
