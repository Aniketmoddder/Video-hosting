import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import AWS from "aws-sdk";
import fs from "fs";
import path from "path";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

// 🔐 ENV (set in Railway)
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

// 📁 Upload (temp)
const upload = multer({ dest: "/tmp" });

// 🚀 Upload API
app.post("/upload", upload.single("video"), async (req, res) => {
  try {
    const videoId = uuidv4();
    const inputPath = req.file.path;
    const outputDir = `/tmp/${videoId}`;

    fs.mkdirSync(outputDir, { recursive: true });

    console.log("⚙️ Processing:", videoId);

    // 🎬 Convert to HLS
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          "-codec: copy",
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

    // ☁️ Upload all files to R2
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

    // 🧹 cleanup
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.unlinkSync(inputPath);

    // 🔗 Playback URL
    const playbackUrl = `${PUBLIC_URL}/${videoId}/master.m3u8`;

    res.json({
      success: true,
      videoId,
      playbackUrl
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

// 🧪 Health
app.get("/", (req, res) => {
  res.send("🔥 Video server running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("🚀 Running on", PORT));
