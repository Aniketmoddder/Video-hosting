import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import AWS from "aws-sdk";
import fs from "fs";
import path from "path";
import cors from "cors";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 ENV
const {
  R2_ENDPOINT,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET,
  PUBLIC_URL
} = process.env;

// ☁️ R2 CONFIG
const s3 = new AWS.S3({
  endpoint: R2_ENDPOINT,
  accessKeyId: R2_ACCESS_KEY,
  secretAccessKey: R2_SECRET_KEY,
  signatureVersion: "v4"
});

// 📁 Upload config
const upload = multer({
  dest: "/tmp",
  limits: { fileSize: 1000 * 1024 * 1024 } // 1GB
});

// 🧠 Job storage
const jobs = {};

// 🧪 Health
app.get("/", (req, res) => {
  res.send("🔥 Async Video Server Running");
});

// 🔍 Status API
app.get("/status/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ error: "Not found" });
  res.json(job);
});

// 🔥 PROCESS FUNCTION (FULL FIX)
async function processVideo(input, videoId, isM3U8 = false) {
  const outputDir = `/tmp/${videoId}`;
  fs.mkdirSync(outputDir, { recursive: true });

  await new Promise((resolve, reject) => {
    let command = ffmpeg(input);

    if (isM3U8) {
      command = command.inputOptions([
        "-protocol_whitelist file,http,https,tcp,tls,crypto",
        "-allowed_extensions ALL",
        "-headers",
        "User-Agent: Mozilla/5.0\r\nReferer: https://google.com\r\nOrigin: https://google.com"
      ]);
    }

    command
      .outputOptions([
        "-map 0",
        "-c copy",
        "-f hls",
        "-hls_time 6",
        "-hls_list_size 0",
        "-hls_segment_filename",
        `${outputDir}/seg_%03d.ts`
      ])
      .output(`${outputDir}/master.m3u8`)
      .on("start", cmd => console.log("FFmpeg:", cmd))
      .on("end", resolve)
      .on("error", reject)
      .run();
  });

  const files = fs.readdirSync(outputDir);

  for (let file of files) {
    const filePath = path.join(outputDir, file);
    const fileContent = fs.readFileSync(filePath);

    await s3.putObject({
      Bucket: R2_BUCKET,
      Key: `${videoId}/${file}`,
      Body: fileContent,
      ContentType: file.endsWith(".m3u8")
        ? "application/vnd.apple.mpegurl"
        : "video/MP2T"
    }).promise();
  }

  fs.rmSync(outputDir, { recursive: true, force: true });

  return `${PUBLIC_URL}/${videoId}/master.m3u8`;
}

// 🎬 FILE UPLOAD
app.post("/upload", upload.single("video"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  const videoId = uuidv4();

  jobs[videoId] = { status: "processing" };

  res.json({
    success: true,
    videoId,
    status: "processing"
  });

  (async () => {
    try {
      const url = await processVideo(req.file.path, videoId);
      fs.unlinkSync(req.file.path);

      jobs[videoId] = {
        status: "completed",
        playbackUrl: url
      };
    } catch (err) {
      console.error(err);
      jobs[videoId] = { status: "failed" };
    }
  })();
});

// 🌐 URL UPLOAD
app.post("/upload-url", async (req, res) => {
  const { videoUrl } = req.body;

  if (!videoUrl) {
    return res.status(400).json({ error: "videoUrl required" });
  }

  const videoId = uuidv4();

  jobs[videoId] = { status: "processing" };

  res.json({
    success: true,
    videoId,
    status: "processing"
  });

  (async () => {
    try {
      const isM3U8 = videoUrl.includes(".m3u8");

      let playbackUrl;

      if (isM3U8) {
        console.log("🎯 M3U8 detected");

        try {
          playbackUrl = await processVideo(videoUrl, videoId, true);
        } catch (err) {
          console.log("⚠️ fallback external");
          jobs[videoId] = {
            status: "completed",
            playbackUrl: videoUrl,
            type: "external"
          };
          return;
        }

      } else {
        console.log("📥 Downloading file");

        const inputPath = `/tmp/${videoId}.mp4`;

        const response = await axios({
          url: videoUrl,
          method: "GET",
          responseType: "stream",
          headers: {
            "User-Agent": "Mozilla/5.0"
          }
        });

        const writer = fs.createWriteStream(inputPath);
        response.data.pipe(writer);

        await new Promise((res, rej) => {
          writer.on("finish", res);
          writer.on("error", rej);
        });

        playbackUrl = await processVideo(inputPath, videoId);

        fs.unlinkSync(inputPath);
      }

      jobs[videoId] = {
        status: "completed",
        playbackUrl
      };

    } catch (err) {
      console.error(err);
      jobs[videoId] = { status: "failed" };
    }
  })();
});

// 🚀 START
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Running on", PORT));
