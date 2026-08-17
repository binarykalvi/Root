const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const OAuth2 = google.auth.OAuth2;

const client_id = process.env.YOUTUBE_CLIENT_ID;
const client_secret = process.env.YOUTUBE_CLIENT_SECRET;
const refresh_token = process.env.YOUTUBE_REFRESH_TOKEN;

const customTitle = process.env.VIDEO_TITLE || '';
const customDescription = process.env.VIDEO_DESCRIPTION || '';
const privacyStatus = process.env.VIDEO_VISIBILITY || 'unlisted';

const oauth2Client = new OAuth2(client_id, client_secret, 'https://developers.google.com/oauthplayground');
oauth2Client.setCredentials({ refresh_token: refresh_token });

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

function getDownloadedVideos(dir) {
  const files = fs.readdirSync(dir);
  const videoFiles = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (['.mp4', '.mkv', '.webm'].includes(ext)) {
      const fullPath = path.join(dir, file);
      const nameWithoutExt = path.basename(file, ext);

      // Match info json created by yt-dlp
      const jsonPath = path.join(dir, `${nameWithoutExt}.info.json`);

      // Match original thumbnail (.jpg, .jpeg, .png, .webp)
      let thumbPath = null;
      for (const thumbExt of ['.jpg', '.jpeg', '.png', '.webp']) {
        const potentialPath = path.join(dir, `${nameWithoutExt}${thumbExt}`);
        if (fs.existsSync(potentialPath)) {
          thumbPath = potentialPath;
          break;
        }
      }

      let meta = { title: nameWithoutExt, description: '' };

      if (fs.existsSync(jsonPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          meta.title = raw.title || nameWithoutExt;
          meta.description = raw.description || '';
        } catch (e) {
          console.warn(`[WARN] Could not parse metadata for ${file}`);
        }
      }

      videoFiles.push({
        filePath: fullPath,
        jsonPath: fs.existsSync(jsonPath) ? jsonPath : null,
        thumbPath: thumbPath,
        title: meta.title,
        description: meta.description,
        ctime: fs.statSync(fullPath).ctimeMs
      });
    }
  }

  // Preserve ordering by file creation time
  return videoFiles.sort((a, b) => a.ctime - b.ctime);
}

async function uploadSingleVideo(video, index, total) {
  let finalTitle = customTitle.trim() !== '' ? customTitle : video.title;
  let finalDesc = customDescription.trim() !== '' ? customDescription : video.description;

  if (total > 1 && customTitle.trim() !== '') {
    finalTitle = `${finalTitle} (Part ${index + 1}/${total})`;
  }

  console.log(`[Y] File: ${path.basename(video.filePath)}`);
  console.log(`[U] Starting: "${finalTitle}" (${privacyStatus})`);

  try {
    const res = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: {
          title: finalTitle,
          description: finalDesc,
        },
        status: {
          privacyStatus: privacyStatus,
        },
      },
      media: {
        body: fs.createReadStream(video.filePath),
      },
    });

    const videoId = res.data.id;
    console.log(`[Y] Success ID: ${videoId}`);
    console.log(`[Y] URL: https://youtu.be/${videoId}`);

    // Upload thumbnail if it exists
    if (video.thumbPath && fs.existsSync(video.thumbPath)) {
      try {
        console.log(`[THUMB] Uploading thumbnail: ${path.basename(video.thumbPath)}`);
        await youtube.thumbnails.set({
          videoId: videoId,
          media: {
            mimeType: 'image/jpeg',
            body: fs.createReadStream(video.thumbPath),
          },
        });
        console.log(`[THUMB] Thumbnail uploaded successfully.`);
      } catch (thumbError) {
        console.warn(`[WARN] Thumbnail upload failed for ${videoId}:`, thumbError.message);
      }
    }

    // Clean up local files immediately
    fs.unlinkSync(video.filePath);
    if (video.jsonPath && fs.existsSync(video.jsonPath)) {
      fs.unlinkSync(video.jsonPath);
    }
    if (video.thumbPath && fs.existsSync(video.thumbPath)) {
      fs.unlinkSync(video.thumbPath);
    }
    console.log(`[DEL] Cleaned files for: ${path.basename(video.filePath)}`);

  } catch (error) {
    console.error(`[ERR] Failed: ${path.basename(video.filePath)}`, error);
    process.exit(1);
  }
}

// Pool runner for parallel task execution
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item, array.indexOf(item), array.length));
    ret.push(p);

    if (poolLimit <= array.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= poolLimit) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(ret);
}

async function main() {
  const downloadsDir = path.join(process.cwd(), 'downloads');
  const targetDir = fs.existsSync(downloadsDir) ? downloadsDir : process.cwd();

  const videos = getDownloadedVideos(targetDir);

  if (videos.length === 0) {
    console.error('[ERR] No downloaded video files found.');
    process.exit(1);
  }

  console.log(`[Y2Y] ${videos.length} video(s) ready for upload. Processing up to 4 concurrently...`);

  // Run up to 4 uploads in parallel
  await asyncPool(4, videos, uploadSingleVideo);

  console.log('[Y2Y] Done.');
}

main();
