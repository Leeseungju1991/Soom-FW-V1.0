import fs from "node:fs";
import path from "node:path";

export class DeviceCommandStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.ensureStore();
  }

  ensureStore() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify({ devices: {} }, null, 2));
    }
  }

  readStore() {
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  writeStore(store) {
    fs.writeFileSync(this.filePath, JSON.stringify(store, null, 2));
  }

  queueReprovision(deviceId) {
    const store = this.readStore();
    store.devices[deviceId] = { next_action: "enter_provisioning" };
    this.writeStore(store);
  }

  consumeNextAction(deviceId) {
    const store = this.readStore();
    const command = store.devices[deviceId]?.next_action ?? "none";
    if (command !== "none") {
      delete store.devices[deviceId];
      this.writeStore(store);
    }
    return command;
  }

  listQueuedDevices() {
    return Object.keys(this.readStore().devices);
  }
}
