import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

import { protocol } from "./protocol.js";
import { DeviceCommandStore } from "./deviceCommandStore.js";

const port = Number(process.env.PORT || 8080);
const apiKey = process.env.API_KEY || "REPLACE_WITH_API_KEY";
const adminToken = process.env.ADMIN_TOKEN || "REPLACE_WITH_ADMIN_TOKEN";
const awsRegion = process.env.AWS_REGION || "ap-northeast-2";
const s3Bucket = process.env.S3_BUCKET || "";
const s3Prefix = process.env.S3_PREFIX || "iconia/events";
const commandStorePath = process.env.COMMAND_STORE_PATH || "./data/device-commands.json";
const localUploadDir = process.env.LOCAL_UPLOAD_DIR || "./data/uploads";

fs.mkdirSync(localUploadDir, { recursive: true });

const app = express();
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, callback) => callback(null, localUploadDir),
    filename: (_req, file, callback) => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      callback(null, `${timestamp}-${file.originalname || "event.jpg"}`);
    },
  }),
  limits: {
    fileSize: 8 * 1024 * 1024,
    files: 1,
  },
});

const commandStore = new DeviceCommandStore(commandStorePath);
const s3Client = s3Bucket ? new S3Client({ region: awsRegion }) : null;

app.use(express.json());

function requireApiKey(req, res, next) {
  if (req.header(protocol.apiKeyHeader) !== apiKey) {
    res.status(401).json({ ok: false, error: "invalid_api_key" });
    return;
  }
  next();
}

function requireAdminToken(req, res, next) {
  if (req.header("x-admin-token") !== adminToken) {
    res.status(401).json({ ok: false, error: "invalid_admin_token" });
    return;
  }
  next();
}

function normalizeDeviceId(value) {
  return String(value || "").trim().toUpperCase();
}

function validateEventRequest(req) {
  const touch = String(req.body[protocol.fields.touch] || "").trim().toLowerCase();
  const deviceId = normalizeDeviceId(req.body[protocol.fields.deviceId]);
  const battery = Number.parseInt(req.body[protocol.fields.battery], 10);

  if (!protocol.touchValues.has(touch)) {
    return { ok: false, error: "invalid_touch" };
  }

  if (!deviceId) {
    return { ok: false, error: "missing_device_id" };
  }

  if (!Number.isInteger(battery) || battery < 0 || battery > 100) {
    return { ok: false, error: "invalid_battery" };
  }

  if (!req.file) {
    return { ok: false, error: "missing_image" };
  }

  return {
    ok: true,
    touch,
    deviceId,
    battery,
  };
}

async function persistImage(filePath, deviceId) {
  const fileName = path.basename(filePath);

  if (!s3Client || !s3Bucket) {
    return {
      storage: "local",
      objectKey: fileName,
      location: filePath,
    };
  }

  const objectKey = `${s3Prefix}/${deviceId}/${fileName}`;
  await s3Client.send(new PutObjectCommand({
    Bucket: s3Bucket,
    Key: objectKey,
    Body: fs.createReadStream(filePath),
    ContentType: "image/jpeg",
  }));

  return {
    storage: "s3",
    objectKey,
    location: `s3://${s3Bucket}/${objectKey}`,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "iconia-cloud-ingest",
    queued_devices: commandStore.listQueuedDevices(),
  });
});

app.post(protocol.apiPath, requireApiKey, upload.single(protocol.fields.image), async (req, res) => {
  const validated = validateEventRequest(req);
  if (!validated.ok) {
    if (req.file?.path) {
      fs.rmSync(req.file.path, { force: true });
    }
    res.status(400).json(validated);
    return;
  }

  try {
    const storageResult = await persistImage(req.file.path, validated.deviceId);
    const nextAction = commandStore.consumeNextAction(validated.deviceId);

    if (nextAction === protocol.commandEnterProvisioning) {
      res.setHeader(protocol.commandHeader, protocol.commandEnterProvisioning);
    }

    res.json({
      ok: true,
      device_id: validated.deviceId,
      touch: validated.touch,
      battery: validated.battery,
      storage: storageResult.storage,
      object_key: storageResult.objectKey,
      location: storageResult.location,
      next_action: nextAction,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: "storage_failed" });
  }
});

app.post("/api/devices/:deviceId/reprovision", requireAdminToken, (req, res) => {
  const deviceId = normalizeDeviceId(req.params.deviceId);
  if (!deviceId) {
    res.status(400).json({ ok: false, error: "missing_device_id" });
    return;
  }

  commandStore.queueReprovision(deviceId);
  res.json({
    ok: true,
    device_id: deviceId,
    queued_command: protocol.commandEnterProvisioning,
  });
});

app.listen(port, () => {
  console.log(`ICONIA cloud ingest listening on :${port}`);
});
