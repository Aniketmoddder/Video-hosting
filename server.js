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

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY,
  R2_SECRET_KEY,
  R2_BUCKET,
  PUBLIC_URL
} = process.env;

const s3 = new AWS.S3({
  endpoint: R2_ENDPOINT,
  accessKeyId: R2_ACCESS_KEY,
  secretAccessKey: R2_SECRET_KEY,
  signatureVersion: "v4"
});

const upload = multer({ dest: "/tmp" });

// 🔧 COMMON PROCESS FUNCTION
async function processAndUpload(input, videoId, isM3U8 = false) {
  const outputDir = `/tmp/${videoId}`;
  fs.mkdirSync(outputDir, { recursive: true });

  console.log("⚙️ Processing:", videoId);

  await new Promise((resolve, reject) => {
    let command = ffmpeg(input);

    if (isM3U8) {
      command = command.inputOptions([
        "-protocol_whitelist file,http,https,tcp,tls"
      ]);
    }

    command
      .outputOptions([
        "-codec copy",
        "-start_number 0",
        "-hls_time 6",
        "-hls_list_size 0",
        "-f hls"
      ])
      .output(`${outputDir}/master.m3u8`)
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
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const videoId = uuidv4();
    const url = await processAndUpload(req.file.path, videoId);

    fs.unlinkSync(req.file.path);

    res.json({ success: true, videoId, playbackUrl: url });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// 🌐 URL UPLOAD (FIXED FOR M3U8)
app.post("/upload-url", async (req, res) => {
  try {
    const { videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({ error: "videoUrl required" });
    }

    const videoId = uuidv4();

    // 🔥 DETECT TYPE
    const isM3U8 = videoUrl.includes(".m3u8");

    let playbackUrl;

    if (isM3U8) {
      console.log("🎯 M3U8 detected");

      playbackUrl = await processAndUpload(videoUrl, videoId, true);

    } else {
      console.log("📥 Downloading file");

      const inputPath = `/tmp/${videoId}.mp4`;

      const response = await axios({
        url: videoUrl,
        method: "GET",
        responseType: "stream"
      });

      const writer = fs.createWriteStream(inputPath);
      response.data.pipe(writer);

      await new Promise((res, rej) => {
        writer.on("finish", res);
        writer.on("error", rej);
      });

      playbackUrl = await processAndUpload(inputPath, videoId);

      fs.unlinkSync(inputPath);
    }

    res.json({ success: true, videoId, playbackUrl });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "URL upload failed" });
  }
});

// 🚀 START
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("🚀 Running on", PORT));
