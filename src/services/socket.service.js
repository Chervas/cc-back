'use strict';
let ioInstance = null;

module.exports = {
    setIO(io) {
        ioInstance = io;
    },
    getIO() {
        return ioInstance;
    },
    emit(event, payload) {
        if (ioInstance) {
            ioInstance.emit(event, payload);
        }
    },
};
