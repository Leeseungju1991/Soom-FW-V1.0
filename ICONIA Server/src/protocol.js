export const protocol = {
  apiPath: "/api/event",
  apiKeyHeader: "x-api-key",
  commandHeader: "X-ICONIA-Command",
  commandEnterProvisioning: "enter_provisioning",
  fields: {
    touch: "touch",
    deviceId: "device_id",
    battery: "battery",
    image: "image",
  },
  touchValues: new Set(["left", "right"]),
};
