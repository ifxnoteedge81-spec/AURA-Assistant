import { downloadMediaMessage, type WAMessage, type WASocket, type proto } from '@whiskeysockets/baileys';
import type { AssistantTone } from './assistantEngine.ts';

export type MediaKind =
  | 'photo'
  | 'video'
  | 'gif'
  | 'sticker'
  | 'story_text'
  | 'audio'
  | 'reaction'
  | 'text';

export type VisualSceneType =
  | 'portrait_person'
  | 'scenery_nature'
  | 'warm_aesthetic'
  | 'screenshot_or_meme'
  | 'dark_or_unclear'
  | 'general_visual'
  | 'none';

export type VisualQuality = 'stunning' | 'good' | 'moody' | 'dark_or_unclear' | 'unknown';

export type MediaSentiment =
  | 'praise_portrait'
  | 'good_positive'
  | 'bad_critique'
  | 'funny_laugh'
  | 'logical_debate'
  | 'affection_like'
  | 'greeting_casual';

export interface StickerExifMetadata {
  packName?: string;
  publisher?: string;
  emojis: string[];
}

export interface VisualPixelAnalysis {
  aspect: 'portrait' | 'landscape' | 'square';
  brightness: number;
  contrast: number;
  saturation: number;
  skinRatio: number;
  centerSkinRatio: number;
  warmRatio: number;
  greenRatio: number;
  blueRatio: number;
  uniformLightRatio: number;
  uniformDarkRatio: number;
  rowEdgeSharpness: number;
  scene: VisualSceneType;
  quality: VisualQuality;
  complimentWorthy: boolean;
}

export interface MediaInsight {
  kind: MediaKind;
  isMedia: boolean;
  isStory: boolean;
  isViewOnce: boolean;
  caption: string;
  quotedSummary: string;
  stickerMeta?: StickerExifMetadata;
  isAnimatedSticker?: boolean;
  isAvatarSticker?: boolean;
  accessibilityLabel?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  reactionEmojiReceived?: string;
  reactionTargetFromMe?: boolean;
  backgroundHex?: string;
  visual?: VisualPixelAnalysis;
  sentiment: MediaSentiment;
  recommendedReaction: string;
  compactContextLine: string;
  banglaSceneLabel: string;
  tokensUsedForRead: 0;
}

export interface SimulatedMediaInput {
  kind: 'photo' | 'video' | 'gif' | 'sticker' | 'story_photo' | 'story_video' | 'story_text' | 'reaction';
  caption?: string;
  visualPreset?: 'portrait_stunning' | 'scenery_beautiful' | 'dark_bad' | 'funny_meme' | 'logical_screenshot';
  stickerEmojis?: string[];
  stickerPackName?: string;
  reactionEmoji?: string;
  durationSec?: number;
  imageBase64?: string;
}

type SharpFactory = (input: Buffer, options?: Record<string, unknown>) => any;
let sharpLoaderPromise: Promise<SharpFactory | null> | null = null;
async function getSharp(): Promise<SharpFactory | null> {
  if (!sharpLoaderPromise) {
    sharpLoaderPromise = import('sharp')
      .then((mod) => (typeof mod?.default === 'function' ? (mod.default as SharpFactory) : null))
      .catch(() => null);
  }
  return sharpLoaderPromise;
}

function withTimeoutLocal<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function unwrapBaileysMessageContent(
  message: proto.IMessage | null | undefined
): {
  unwrapped: proto.IMessage | null;
  isViewOnce: boolean;
  isStatusMention: boolean;
} {
  if (!message) {
    return { unwrapped: null, isViewOnce: false, isStatusMention: false };
  }
  let cur: proto.IMessage | null | undefined = message;
  let isViewOnce = false;
  let isStatusMention = false;

  for (let depth = 0; depth < 6 && cur; depth += 1) {
    if (cur.ephemeralMessage?.message) {
      cur = cur.ephemeralMessage.message;
      continue;
    }
    if (cur.viewOnceMessage?.message) {
      isViewOnce = true;
      cur = cur.viewOnceMessage.message;
      continue;
    }
    if (cur.viewOnceMessageV2?.message) {
      isViewOnce = true;
      cur = cur.viewOnceMessageV2.message;
      continue;
    }
    if (cur.viewOnceMessageV2Extension?.message) {
      isViewOnce = true;
      cur = cur.viewOnceMessageV2Extension.message;
      continue;
    }
    if (cur.documentWithCaptionMessage?.message) {
      cur = cur.documentWithCaptionMessage.message;
      continue;
    }
    if (cur.editedMessage?.message) {
      cur = cur.editedMessage.message;
      continue;
    }
    if (cur.statusMentionMessage?.message) {
      isStatusMention = true;
      cur = cur.statusMentionMessage.message;
      continue;
    }
    break;
  }

  if (cur?.imageMessage?.viewOnce || cur?.videoMessage?.viewOnce) {
    isViewOnce = true;
  }

  return { unwrapped: cur || null, isViewOnce, isStatusMention };
}

/**
 * Pure TypeScript WebP EXIF chunk parser (0 AI tokens).
 * Extracts WhatsApp sticker pack name, publisher, and embedded emojis directly from RIFF/WEBP bytes.
 */
export function parseWebpStickerExif(webpBuffer: Buffer | Uint8Array | null | undefined): StickerExifMetadata {
  const empty: StickerExifMetadata = { emojis: [] };
  if (!webpBuffer || webpBuffer.length < 20) return empty;
  const buf = Buffer.isBuffer(webpBuffer) ? webpBuffer : Buffer.from(webpBuffer);

  // Check RIFF....WEBP header or scan for embedded WhatsApp sticker JSON directly
  let jsonCandidate = '';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    let offset = 12;
    while (offset + 8 <= buf.length) {
      const chunkId = buf.subarray(offset, offset + 4).toString('ascii');
      const chunkSize = buf.readUInt32LE(offset + 4);
      const payloadStart = offset + 8;
      const payloadEnd = Math.min(buf.length, payloadStart + chunkSize);
      if (chunkId === 'EXIF' || chunkId === 'XMP ') {
        const chunkStr = buf.subarray(payloadStart, payloadEnd).toString('utf8');
        const jsonMatch = chunkStr.match(/\{[\s\S]*"(?:sticker-pack-name|emojis|android-app-store-link)"[\s\S]*\}/);
        if (jsonMatch) {
          jsonCandidate = jsonMatch[0];
          break;
        }
      }
      offset = payloadStart + chunkSize + (chunkSize % 2);
      if (chunkSize === 0) break;
    }
  }

  if (!jsonCandidate) {
    const rawUtf8 = buf.toString('utf8');
    const fallbackMatch = rawUtf8.match(/\{[^{}]{0,600}"(?:sticker-pack-name|emojis)"[^{}]{0,600}\}/);
    if (fallbackMatch) {
      jsonCandidate = fallbackMatch[0];
    }
  }

  if (!jsonCandidate) return empty;

  try {
    const endBrace = jsonCandidate.lastIndexOf('}');
    const cleaned = endBrace !== -1 ? jsonCandidate.slice(0, endBrace + 1) : jsonCandidate;
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const emojis = Array.isArray(parsed.emojis)
      ? parsed.emojis.map((e) => String(e || '').trim()).filter(Boolean).slice(0, 8)
      : [];
    const packName =
      typeof parsed['sticker-pack-name'] === 'string'
        ? parsed['sticker-pack-name'].trim().slice(0, 80)
        : undefined;
    const publisher =
      typeof parsed['sticker-pack-publisher'] === 'string'
        ? parsed['sticker-pack-publisher'].trim().slice(0, 60)
        : undefined;
    return { packName, publisher, emojis };
  } catch {
    return empty;
  }
}

/**
 * Pure Local Pixel & Scene Analyzer using sharp at 48x48 RGB (0 API tokens, ~2ms).
 * Identifies portraits/selfies, scenery, warm aesthetic shots, screenshots/memes, and dark/blurry photos.
 */
export async function analyzeVisualBufferZeroToken(
  rawBuffer: Buffer | Uint8Array | null | undefined,
  declaredWidth?: number | null,
  declaredHeight?: number | null
): Promise<VisualPixelAnalysis | undefined> {
  if (!rawBuffer || rawBuffer.length < 32) return undefined;
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);
  const sharpFn = await getSharp();
  if (!sharpFn) return undefined;

  try {
    const img = sharpFn(buf, { failOn: 'none' });
    const meta = await img.metadata().catch(() => ({ width: declaredWidth || 0, height: declaredHeight || 0 }));
    const w = Number(declaredWidth || meta?.width || 100);
    const h = Number(declaredHeight || meta?.height || 100);
    const aspect: VisualPixelAnalysis['aspect'] =
      h > w * 1.15 ? 'portrait' : w > h * 1.15 ? 'landscape' : 'square';

    const SIZE = 48;
    const rawRgb = (await img
      .resize(SIZE, SIZE, { fit: 'fill' })
      .removeAlpha()
      .toColorspace('srgb')
      .raw()
      .toBuffer()) as Buffer;

    const totalPixels = SIZE * SIZE;
    if (rawRgb.length < totalPixels * 3) return undefined;

    let sumLuma = 0;
    let sumLumaSq = 0;
    let sumSat = 0;
    let skinPixels = 0;
    let centerPixels = 0;
    let centerSkinPixels = 0;
    let warmPixels = 0;
    let greenPixels = 0;
    let bluePixels = 0;
    let topBluePixels = 0;
    let uniformLight = 0;
    let uniformDark = 0;
    let edgeHits = 0;

    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const idx = (y * SIZE + x) * 3;
        const r = rawRgb[idx];
        const g = rawRgb[idx + 1];
        const b = rawRgb[idx + 2];

        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        sumLuma += luma;
        sumLumaSq += luma * luma;

        const maxC = Math.max(r, g, b);
        const minC = Math.min(r, g, b);
        const sat = maxC > 0 ? (maxC - minC) / maxC : 0;
        sumSat += sat;

        // Skin tone heuristic (RGB + YCbCr cluster)
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        const isSkinYCbCr = cb >= 77 && cb <= 129 && cr >= 133 && cr <= 176 && luma > 48 && luma < 245;
        const isSkinRgb = r > 88 && g > 40 && b > 20 && maxC - minC > 14 && Math.abs(r - g) > 12 && r > g && r > b;
        const isSkin = isSkinYCbCr && isSkinRgb;
        if (isSkin) skinPixels += 1;

        const inCenter = x >= 10 && x <= 37 && y >= 6 && y <= 40;
        if (inCenter) {
          centerPixels += 1;
          if (isSkin) centerSkinPixels += 1;
        }

        if (r > g + 18 && r > b + 22 && sat > 0.22) warmPixels += 1;
        if (g > r + 10 && g > b + 10 && sat > 0.18) greenPixels += 1;
        if (b > r + 15 && b > g + 5 && sat > 0.18) {
          bluePixels += 1;
          if (y < SIZE * 0.45) topBluePixels += 1;
        }

        if (r > 232 && g > 232 && b > 232) uniformLight += 1;
        if (r < 34 && g < 34 && b < 34) uniformDark += 1;

        if (x > 0) {
          const prevIdx = (y * SIZE + (x - 1)) * 3;
          const prevLuma = 0.299 * rawRgb[prevIdx] + 0.587 * rawRgb[prevIdx + 1] + 0.114 * rawRgb[prevIdx + 2];
          if (Math.abs(luma - prevLuma) > 45) edgeHits += 1;
        }
      }
    }

    const brightness = sumLuma / totalPixels;
    const variance = Math.max(0, sumLumaSq / totalPixels - brightness * brightness);
    const contrast = Math.sqrt(variance);
    const saturation = sumSat / totalPixels;
    const skinRatio = skinPixels / totalPixels;
    const centerSkinRatio = centerPixels > 0 ? centerSkinPixels / centerPixels : skinRatio;
    const warmRatio = warmPixels / totalPixels;
    const greenRatio = greenPixels / totalPixels;
    const blueRatio = bluePixels / totalPixels;
    const uniformLightRatio = uniformLight / totalPixels;
    const uniformDarkRatio = uniformDark / totalPixels;
    const rowEdgeSharpness = edgeHits / totalPixels;

    let scene: VisualSceneType = 'general_visual';
    let quality: VisualQuality = 'good';
    let complimentWorthy = false;

    const looksLikeScreenshot =
      (uniformLightRatio > 0.48 && rowEdgeSharpness > 0.09) ||
      (uniformDarkRatio > 0.55 && rowEdgeSharpness > 0.08 && centerSkinRatio < 0.04) ||
      (uniformLightRatio > 0.65 && saturation < 0.15);

    const looksDarkOrUnclear = brightness < 34 || (contrast < 13 && brightness < 75);

    const looksLikePortrait =
      !looksLikeScreenshot &&
      !looksDarkOrUnclear &&
      ((centerSkinRatio >= 0.08 && skinRatio >= 0.05) ||
        (aspect === 'portrait' && centerSkinRatio >= 0.055 && contrast >= 22));

    const looksLikeScenery =
      !looksLikePortrait &&
      !looksLikeScreenshot &&
      !looksDarkOrUnclear &&
      (greenRatio >= 0.14 || (blueRatio >= 0.14 && topBluePixels / (SIZE * SIZE * 0.45) >= 0.2));

    if (looksDarkOrUnclear) {
      scene = 'dark_or_unclear';
      quality = 'dark_or_unclear';
    } else if (looksLikeScreenshot) {
      scene = 'screenshot_or_meme';
      quality = 'good';
    } else if (looksLikePortrait) {
      scene = 'portrait_person';
      const vibrantOrWellLit = brightness >= 75 && brightness <= 218 && contrast >= 30;
      quality = vibrantOrWellLit && (saturation >= 0.22 || warmRatio >= 0.12) ? 'stunning' : brightness < 68 ? 'moody' : 'good';
      complimentWorthy = true;
    } else if (looksLikeScenery) {
      scene = 'scenery_nature';
      quality = saturation >= 0.26 && contrast >= 28 ? 'stunning' : 'good';
      complimentWorthy = quality === 'stunning';
    } else if (warmRatio >= 0.22 && saturation >= 0.24 && brightness >= 70) {
      scene = 'warm_aesthetic';
      quality = contrast >= 28 ? 'stunning' : 'good';
      complimentWorthy = true;
    } else {
      scene = 'general_visual';
      quality = contrast >= 35 && saturation >= 0.25 ? 'good' : brightness < 65 ? 'moody' : 'good';
    }

    return {
      aspect,
      brightness: Math.round(brightness),
      contrast: Math.round(contrast),
      saturation: Number(saturation.toFixed(2)),
      skinRatio: Number(skinRatio.toFixed(2)),
      centerSkinRatio: Number(centerSkinRatio.toFixed(2)),
      warmRatio: Number(warmRatio.toFixed(2)),
      greenRatio: Number(greenRatio.toFixed(2)),
      blueRatio: Number(blueRatio.toFixed(2)),
      uniformLightRatio: Number(uniformLightRatio.toFixed(2)),
      uniformDarkRatio: Number(uniformDarkRatio.toFixed(2)),
      rowEdgeSharpness: Number(rowEdgeSharpness.toFixed(2)),
      scene,
      quality,
      complimentWorthy,
    };
  } catch {
    return undefined;
  }
}

const FUNNY_PATTERN =
  /(?:😂|🤣|😆|😹|💀|🤡|😜|🤪|\b(?:haha+|hehe+|hihi+|lol|lmao|rofl|meme|comedy|funny|troll|roast|maja|mojar|fani)\b|হাহা|মজা|হাসি|কমেডি|ফানি|চাপা|পচানি)/iu;
const LOVE_PATTERN =
  /(?:❤️|♥️|😍|🥰|😘|💕|💖|💘|💓|🌸|🥺|🤗|\b(?:love|cute|sweet|miss|jaan|jan|beautiful|handsome|pretty|gorgeous|lovely|crush|sundor|osadharon|mashallah)\b|সুন্দর|ভালোবাসা|মিষ্টি|মাশাআল্লাহ|অসাধারণ|দারুণ|কিউট)/iu;
const BAD_PATTERN =
  /(?:😡|🤬|😤|😢|😭|💔|😞|😒|🙄|💩|🤢|🤮|\b(?:sad|angry|bad|worst|ugly|boring|trash|cringe|problem|issue|broken|fail|upset|hurt|sorry|kharab|baje|faltu|noshto|kosto)\b|খারাপ|বাজে|কষ্ট|দুঃখ|মন খারাপ|রাগ|বিরক্ত|জঘন্য|ফালতু|সমস্যা|নষ্ট)/iu;
const LOGIC_PATTERN =
  /(?:\?|\b(?:why|how|what|logic|proof|fact|reason|debate|true|false|agree|disagree|think|opinion|code|ai|news|notice|update|screenshot|keno|kivabe|kibhabe|jukti|motamot|hisab|thik kina)\b|কেন|কিভাবে|কীভাবে|যুক্তি|কারণ|সত্যি|মিথ্যা|মতামত|প্রশ্ন|হিসাব|লজিক|ব্যাখ্যা|ঠিক কিনা|বলো তো)/iu;
const GOOD_PATTERN =
  /(?:👍|👏|🔥|💯|🤩|🎉|🙌|✨|🌟|🏆|\b(?:good|great|nice|awesome|amazing|congrats|win|winner|success|happy|alhamdulillah|bhalo|valo|darun|joss|sera|dhonyobad|thanks)\b|ভালো|দারুণ|চমৎকার|জোস|অভিনন্দন|আলহামদুলিল্লাহ|সেরা|খুশি|ধন্যবাদ|থ্যাংকস)/iu;

function classifySentiment(params: {
  kind: MediaKind;
  caption: string;
  quotedSummary: string;
  stickerMeta?: StickerExifMetadata;
  accessibilityLabel?: string;
  reactionEmoji?: string;
  visual?: VisualPixelAnalysis;
  gifPlayback?: boolean;
  isAvatar?: boolean;
}): { sentiment: MediaSentiment; recommendedReaction: string; banglaSceneLabel: string } {
  const {
    kind,
    caption,
    quotedSummary,
    stickerMeta,
    accessibilityLabel = '',
    reactionEmoji = '',
    visual,
    gifPlayback,
    isAvatar,
  } = params;

  const combinedText = [
    caption,
    quotedSummary,
    accessibilityLabel,
    stickerMeta?.packName || '',
    ...(stickerMeta?.emojis || []),
    reactionEmoji,
  ]
    .filter(Boolean)
    .join(' ')
    .trim();

  // 1. Reaction / Like received
  if (kind === 'reaction') {
    if (FUNNY_PATTERN.test(reactionEmoji)) {
      return { sentiment: 'funny_laugh', recommendedReaction: '😂', banglaSceneLabel: `হাসির রিয়্যাক্ট (${reactionEmoji})` };
    }
    if (BAD_PATTERN.test(reactionEmoji)) {
      return { sentiment: 'bad_critique', recommendedReaction: '👀', banglaSceneLabel: `নেগেটিভ/অবাক রিয়্যাক্ট (${reactionEmoji})` };
    }
    if (LOVE_PATTERN.test(reactionEmoji)) {
      return { sentiment: 'affection_like', recommendedReaction: '❤️', banglaSceneLabel: `লাভ/পজিটিভ লাইক (${reactionEmoji})` };
    }
    return { sentiment: 'good_positive', recommendedReaction: '👍', banglaSceneLabel: `লাইক রিয়্যাক্ট (${reactionEmoji || '👍'})` };
  }

  // 2. Explicit text/emoji cues first (caption / sticker EXIF / accessibility)
  if (LOGIC_PATTERN.test(combinedText)) {
    return {
      sentiment: 'logical_debate',
      recommendedReaction: '🤔',
      banglaSceneLabel: kind === 'sticker' ? 'যুক্তি/চিন্তাশীল স্টিকার' : 'যুক্তি/তর্ক বা প্রশ্নভিত্তিক কন্টেন্ট',
    };
  }
  if (FUNNY_PATTERN.test(combinedText) || (kind === 'gif' && !LOVE_PATTERN.test(combinedText))) {
    return {
      sentiment: 'funny_laugh',
      recommendedReaction: '😂',
      banglaSceneLabel:
        kind === 'gif' ? 'হাসির GIF/মিম ক্লিপ' : kind === 'sticker' ? 'হাসির/মজার স্টিকার' : 'হাসির/মজার কন্টেন্ট',
    };
  }
  if (BAD_PATTERN.test(combinedText)) {
    return {
      sentiment: 'bad_critique',
      recommendedReaction: '😢',
      banglaSceneLabel: kind === 'sticker' ? 'মন খারাপ বা রাগের স্টিকার' : 'মন খারাপ / সমস্যা / নেগেটিভ কন্টেন্ট',
    };
  }

  // 3. Visual pixel inspection cues (Photos / Video Thumbnails / Stories)
  if (visual) {
    if (visual.scene === 'dark_or_unclear') {
      return {
        sentiment: 'bad_critique',
        recommendedReaction: '👀',
        banglaSceneLabel: 'অন্ধকার বা অস্পষ্ট ছবি/ভিডিও',
      };
    }
    if (visual.scene === 'portrait_person') {
      return {
        sentiment: 'praise_portrait',
        recommendedReaction: '😍',
        banglaSceneLabel:
          visual.quality === 'stunning'
            ? 'কারো সুন্দর ও স্টাইলিশ ছবি / পোর্ট্রেট'
            : 'কারো ছবি / সেলফি / পোর্ট্রেট',
      };
    }
    if (visual.scene === 'screenshot_or_meme') {
      return {
        sentiment: 'logical_debate',
        recommendedReaction: '👀',
        banglaSceneLabel: 'স্ক্রিনশট / তথ্য বা টেক্সট পোস্ট',
      };
    }
    if (visual.scene === 'scenery_nature' || visual.scene === 'warm_aesthetic') {
      return {
        sentiment: 'good_positive',
        recommendedReaction: '🔥',
        banglaSceneLabel:
          visual.scene === 'scenery_nature' ? 'প্রকৃতি / ভ্রমণের সুন্দর দৃশ্য' : 'আকর্ষণীয় ও নান্দনিক দৃশ্য',
      };
    }
  }

  // 4. Love/Good text cues
  if (LOVE_PATTERN.test(combinedText)) {
    return {
      sentiment: kind === 'photo' || kind === 'video' ? 'praise_portrait' : 'affection_like',
      recommendedReaction: '❤️',
      banglaSceneLabel: kind === 'sticker' ? 'ভালোবাসা বা কিউট স্টিকার' : 'সুন্দর ও আন্তরিক কন্টেন্ট',
    };
  }
  if (GOOD_PATTERN.test(combinedText)) {
    return {
      sentiment: 'good_positive',
      recommendedReaction: '👏',
      banglaSceneLabel: 'ভালো ও পজিটিভ কন্টেন্ট',
    };
  }

  // 5. Avatar/GIF/Sticker defaults (0 tokens)
  if (kind === 'sticker') {
    if (isAvatar) {
      return { sentiment: 'funny_laugh', recommendedReaction: '😄', banglaSceneLabel: 'অ্যাভাটার স্টিকার' };
    }
    if (gifPlayback) {
      return { sentiment: 'funny_laugh', recommendedReaction: '😂', banglaSceneLabel: 'অ্যানিমেটেড স্টিকার' };
    }
    return { sentiment: 'greeting_casual', recommendedReaction: '👍', banglaSceneLabel: 'চ্যাট স্টিকার' };
  }

  if (kind === 'photo' || kind === 'video') {
    return {
      sentiment: 'good_positive',
      recommendedReaction: '❤️',
      banglaSceneLabel: kind === 'video' ? 'ভিডিও ক্লিপ' : 'ফটো',
    };
  }

  if (kind === 'audio') {
    return { sentiment: 'greeting_casual', recommendedReaction: '👍', banglaSceneLabel: 'ভয়েস/অডিও বার্তা' };
  }

  return { sentiment: 'greeting_casual', recommendedReaction: '👍', banglaSceneLabel: 'সাধারণ স্ট্যাটাস/বার্তা' };
}

function summarizeQuotedMessage(ctx: proto.IContextInfo | null | undefined): string {
  if (!ctx?.quotedMessage) return '';
  const { unwrapped } = unwrapBaileysMessageContent(ctx.quotedMessage);
  if (!unwrapped) return '';
  const text =
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.imageMessage?.caption ||
    unwrapped.videoMessage?.caption ||
    '';
  if (text.trim()) return text.trim().slice(0, 140);
  if (unwrapped.imageMessage) return '[Quoted Photo]';
  if (unwrapped.videoMessage) return '[Quoted Video]';
  if (unwrapped.stickerMessage) return '[Quoted Sticker]';
  return '';
}

function buildCompactContextLine(insight: Omit<MediaInsight, 'compactContextLine'>): string {
  const parts: string[] = [];
  if (insight.isStory) parts.push('WhatsApp Story');
  if (insight.isViewOnce) parts.push('View-Once');

  const kindTagMap: Record<MediaKind, string> = {
    photo: 'Photo',
    video: `Video${insight.durationSec ? ` (${insight.durationSec}s)` : ''}`,
    gif: 'Funny GIF',
    sticker: `Sticker${insight.isAnimatedSticker ? ' (Animated)' : ''}`,
    story_text: 'Text Story',
    audio: `Voice Note${insight.durationSec ? ` (${insight.durationSec}s)` : ''}`,
    reaction: `Reaction/Like (${insight.reactionEmojiReceived || '❤️'})`,
    text: 'Text',
  };
  parts.push(kindTagMap[insight.kind]);

  if (insight.banglaSceneLabel) parts.push(insight.banglaSceneLabel);
  if (insight.stickerMeta?.emojis?.length) parts.push(`Emojis: ${insight.stickerMeta.emojis.join('')}`);
  if (insight.stickerMeta?.packName) parts.push(`Pack: ${insight.stickerMeta.packName}`);
  if (insight.visual) {
    parts.push(`Visual: ${insight.visual.aspect}, ${insight.visual.quality}, brightness=${insight.visual.brightness}`);
  }
  if (insight.caption) parts.push(`Caption/Text: "${insight.caption}"`);
  if (insight.quotedSummary) parts.push(`Replying to: "${insight.quotedSummary}"`);

  return `[${parts.join(' • ')}]`;
}

/**
 * Reads any live Baileys WhatsApp message (Story, Sticker, Photo, Video, GIF, Reaction, Voice)
 * using 100% local metadata, WebP EXIF extraction, and sharp thumbnail pixel analysis.
 * GUARANTEED 0 LLM/Vision API tokens consumed.
 */
export async function readMediaMessageZeroToken(
  msg: WAMessage,
  sock?: WASocket | null
): Promise<MediaInsight> {
  const remoteJid = msg.key?.remoteJid || '';
  const isStoryRemote = remoteJid === 'status@broadcast';
  const { unwrapped, isViewOnce, isStatusMention } = unwrapBaileysMessageContent(msg.message);
  const isStory = isStoryRemote || isStatusMention;

  if (!unwrapped) {
    const empty: Omit<MediaInsight, 'compactContextLine'> = {
      kind: 'text',
      isMedia: false,
      isStory,
      isViewOnce,
      caption: '',
      quotedSummary: '',
      sentiment: 'greeting_casual',
      recommendedReaction: '',
      banglaSceneLabel: '',
      tokensUsedForRead: 0,
    };
    return { ...empty, compactContextLine: '' };
  }

  // 1. Reaction / Like Message
  if (unwrapped.reactionMessage) {
    const emoji = (unwrapped.reactionMessage.text || '').trim();
    const quotedSummary = '';
    const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
      kind: 'reaction',
      caption: '',
      quotedSummary,
      reactionEmoji: emoji,
    });
    const base: Omit<MediaInsight, 'compactContextLine'> = {
      kind: 'reaction',
      isMedia: true,
      isStory,
      isViewOnce,
      caption: emoji,
      quotedSummary,
      reactionEmojiReceived: emoji,
      reactionTargetFromMe: Boolean(unwrapped.reactionMessage.key?.fromMe),
      sentiment,
      recommendedReaction,
      banglaSceneLabel,
      tokensUsedForRead: 0,
    };
    return { ...base, compactContextLine: buildCompactContextLine(base) };
  }

  // 2. Sticker Message (WebP EXIF + PNG thumbnail + accessibilityLabel)
  if (unwrapped.stickerMessage) {
    const st = unwrapped.stickerMessage;
    const quotedSummary = summarizeQuotedMessage(st.contextInfo);
    const accessibilityLabel = (st.accessibilityLabel || '').trim();
    let stickerMeta: StickerExifMetadata = { emojis: [] };
    let visual: VisualPixelAnalysis | undefined;

    if (st.pngThumbnail && st.pngThumbnail.length > 24) {
      visual = await analyzeVisualBufferZeroToken(st.pngThumbnail, st.width, st.height);
    }

    // Download tiny sticker WebP (<512KB) locally to read EXIF emojis/pack name — 0 API tokens
    const fileLen = Number(st.fileLength || 0);
    if (sock && (st.url || st.directPath) && fileLen <= 600_000) {
      try {
        const downloaded = await withTimeoutLocal(
          downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: sock.logger,
              reuploadRequest: sock.updateMediaMessage,
            }
          ),
          2200
        );
        if (Buffer.isBuffer(downloaded)) {
          stickerMeta = parseWebpStickerExif(downloaded);
          if (!visual) {
            visual = await analyzeVisualBufferZeroToken(downloaded, st.width, st.height);
          }
        }
      } catch {
        // Safe non-fatal skip if WhatsApp CDN download times out
      }
    }

    const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
      kind: 'sticker',
      caption: '',
      quotedSummary,
      stickerMeta,
      accessibilityLabel,
      visual,
      gifPlayback: Boolean(st.isAnimated),
      isAvatar: Boolean(st.isAvatar),
    });

    const base: Omit<MediaInsight, 'compactContextLine'> = {
      kind: 'sticker',
      isMedia: true,
      isStory,
      isViewOnce,
      caption: accessibilityLabel,
      quotedSummary,
      stickerMeta,
      isAnimatedSticker: Boolean(st.isAnimated || st.isLottie),
      isAvatarSticker: Boolean(st.isAvatar),
      accessibilityLabel,
      width: st.width || undefined,
      height: st.height || undefined,
      visual,
      sentiment,
      recommendedReaction,
      banglaSceneLabel,
      tokensUsedForRead: 0,
    };
    return { ...base, compactContextLine: buildCompactContextLine(base) };
  }

  // 3. Image / Photo Message (Story photo, View-Once photo, or chat photo)
  if (unwrapped.imageMessage) {
    const img = unwrapped.imageMessage;
    const caption = (img.caption || '').trim();
    const accessibilityLabel = (img.accessibilityLabel || '').trim();
    const quotedSummary = summarizeQuotedMessage(img.contextInfo);
    let thumbBuf: Buffer | Uint8Array | null | undefined = img.jpegThumbnail;

    // If protobuf omitted thumbnail on a small image, fetch buffer locally for sharp 48x48 analysis (0 tokens)
    const fileLen = Number(img.fileLength || 0);
    if ((!thumbBuf || thumbBuf.length < 32) && sock && (img.url || img.directPath) && fileLen <= 4_500_000) {
      try {
        const downloaded = await withTimeoutLocal(
          downloadMediaMessage(
            msg,
            'buffer',
            {},
            {
              logger: sock.logger,
              reuploadRequest: sock.updateMediaMessage,
            }
          ),
          2500
        );
        if (Buffer.isBuffer(downloaded)) thumbBuf = downloaded;
      } catch {
        // continue with metadata-only analysis
      }
    }

    const visual = await analyzeVisualBufferZeroToken(thumbBuf, img.width, img.height);
    const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
      kind: 'photo',
      caption,
      quotedSummary,
      accessibilityLabel,
      visual,
    });

    const base: Omit<MediaInsight, 'compactContextLine'> = {
      kind: 'photo',
      isMedia: true,
      isStory,
      isViewOnce,
      caption,
      quotedSummary,
      accessibilityLabel,
      width: img.width || undefined,
      height: img.height || undefined,
      visual,
      sentiment,
      recommendedReaction,
      banglaSceneLabel,
      tokensUsedForRead: 0,
    };
    return { ...base, compactContextLine: buildCompactContextLine(base) };
  }

  // 4. Video / GIF Message (Story video, Reel, Meme GIF, or chat video)
  if (unwrapped.videoMessage) {
    const vid = unwrapped.videoMessage;
    const caption = (vid.caption || '').trim();
    const accessibilityLabel = (vid.accessibilityLabel || '').trim();
    const quotedSummary = summarizeQuotedMessage(vid.contextInfo);
    const isGif = Boolean(vid.gifPlayback);
    const kind: MediaKind = isGif ? 'gif' : 'video';
    const visual = await analyzeVisualBufferZeroToken(vid.jpegThumbnail, vid.width, vid.height);

    const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
      kind,
      caption,
      quotedSummary,
      accessibilityLabel,
      visual,
      gifPlayback: isGif,
    });

    const base: Omit<MediaInsight, 'compactContextLine'> = {
      kind,
      isMedia: true,
      isStory,
      isViewOnce,
      caption,
      quotedSummary,
      accessibilityLabel,
      durationSec: vid.seconds || undefined,
      width: vid.width || undefined,
      height: vid.height || undefined,
      visual,
      sentiment,
      recommendedReaction,
      banglaSceneLabel,
      tokensUsedForRead: 0,
    };
    return { ...base, compactContextLine: buildCompactContextLine(base) };
  }

  // 5. Audio / Voice Note
  if (unwrapped.audioMessage) {
    const aud = unwrapped.audioMessage;
    const quotedSummary = summarizeQuotedMessage(aud.contextInfo);
    const base: Omit<MediaInsight, 'compactContextLine'> = {
      kind: 'audio',
      isMedia: true,
      isStory,
      isViewOnce,
      caption: '',
      quotedSummary,
      durationSec: aud.seconds || undefined,
      sentiment: 'greeting_casual',
      recommendedReaction: '👍',
      banglaSceneLabel: `ভয়েস/অডিও (${aud.seconds || '?'}s)`,
      tokensUsedForRead: 0,
    };
    return { ...base, compactContextLine: buildCompactContextLine(base) };
  }

  // 6. Text Story (status@broadcast extendedTextMessage / conversation) or Normal Text
  const textBody = (
    unwrapped.conversation ||
    unwrapped.extendedTextMessage?.text ||
    unwrapped.documentMessage?.caption ||
    unwrapped.buttonsResponseMessage?.selectedDisplayText ||
    unwrapped.listResponseMessage?.title ||
    ''
  ).trim();
  const quotedSummary = summarizeQuotedMessage(unwrapped.extendedTextMessage?.contextInfo);
  const bgNum = unwrapped.extendedTextMessage?.backgroundArgb;
  const backgroundHex =
    typeof bgNum === 'number' && bgNum !== 0
      ? `#${(bgNum >>> 0).toString(16).padStart(8, '0').slice(2)}`
      : undefined;

  const kind: MediaKind = isStory ? 'story_text' : 'text';
  const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
    kind,
    caption: textBody,
    quotedSummary,
  });

  const base: Omit<MediaInsight, 'compactContextLine'> = {
    kind,
    isMedia: isStory,
    isStory,
    isViewOnce,
    caption: textBody,
    quotedSummary,
    backgroundHex,
    sentiment,
    recommendedReaction,
    banglaSceneLabel,
    tokensUsedForRead: 0,
  };

  return {
    ...base,
    compactContextLine: isStory || quotedSummary ? buildCompactContextLine(base) : textBody,
  };
}

/**
 * Simulator Helper: Reads simulated Story/Sticker/Photo/Video payloads or uploaded images at 0 tokens.
 */
export async function analyzeSimulatedMediaZeroToken(sim: SimulatedMediaInput): Promise<MediaInsight> {
  const caption = (sim.caption || '').trim();
  const isStory =
    sim.kind === 'story_photo' || sim.kind === 'story_video' || sim.kind === 'story_text';
  const kind: MediaKind =
    sim.kind === 'story_photo'
      ? 'photo'
      : sim.kind === 'story_video'
        ? 'video'
        : sim.kind;

  let visual: VisualPixelAnalysis | undefined;
  if (sim.imageBase64) {
    const rawB64 = sim.imageBase64.replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '');
    try {
      const buf = Buffer.from(rawB64, 'base64');
      visual = await analyzeVisualBufferZeroToken(buf);
    } catch {
      // ignore invalid base64
    }
  }

  if (!visual && sim.visualPreset) {
    const presetMap: Record<NonNullable<SimulatedMediaInput['visualPreset']>, VisualPixelAnalysis> = {
      portrait_stunning: {
        aspect: 'portrait',
        brightness: 148,
        contrast: 46,
        saturation: 0.34,
        skinRatio: 0.24,
        centerSkinRatio: 0.32,
        warmRatio: 0.26,
        greenRatio: 0.05,
        blueRatio: 0.08,
        uniformLightRatio: 0.04,
        uniformDarkRatio: 0.03,
        rowEdgeSharpness: 0.06,
        scene: 'portrait_person',
        quality: 'stunning',
        complimentWorthy: true,
      },
      scenery_beautiful: {
        aspect: 'landscape',
        brightness: 156,
        contrast: 52,
        saturation: 0.44,
        skinRatio: 0.01,
        centerSkinRatio: 0.01,
        warmRatio: 0.14,
        greenRatio: 0.34,
        blueRatio: 0.31,
        uniformLightRatio: 0.02,
        uniformDarkRatio: 0.02,
        rowEdgeSharpness: 0.05,
        scene: 'scenery_nature',
        quality: 'stunning',
        complimentWorthy: true,
      },
      dark_bad: {
        aspect: 'portrait',
        brightness: 19,
        contrast: 10,
        saturation: 0.08,
        skinRatio: 0,
        centerSkinRatio: 0,
        warmRatio: 0.02,
        greenRatio: 0.01,
        blueRatio: 0.02,
        uniformLightRatio: 0,
        uniformDarkRatio: 0.82,
        rowEdgeSharpness: 0.01,
        scene: 'dark_or_unclear',
        quality: 'dark_or_unclear',
        complimentWorthy: false,
      },
      funny_meme: {
        aspect: 'square',
        brightness: 175,
        contrast: 58,
        saturation: 0.35,
        skinRatio: 0.04,
        centerSkinRatio: 0.03,
        warmRatio: 0.18,
        greenRatio: 0.06,
        blueRatio: 0.07,
        uniformLightRatio: 0.28,
        uniformDarkRatio: 0.04,
        rowEdgeSharpness: 0.11,
        scene: 'general_visual',
        quality: 'good',
        complimentWorthy: false,
      },
      logical_screenshot: {
        aspect: 'portrait',
        brightness: 215,
        contrast: 64,
        saturation: 0.09,
        skinRatio: 0,
        centerSkinRatio: 0,
        warmRatio: 0.02,
        greenRatio: 0.01,
        blueRatio: 0.05,
        uniformLightRatio: 0.62,
        uniformDarkRatio: 0.02,
        rowEdgeSharpness: 0.16,
        scene: 'screenshot_or_meme',
        quality: 'good',
        complimentWorthy: false,
      },
    };
    visual = presetMap[sim.visualPreset];
  }

  const stickerMeta =
    kind === 'sticker'
      ? {
          emojis: sim.stickerEmojis || [],
          packName: sim.stickerPackName || 'Simulated Sticker Pack',
        }
      : undefined;

  const { sentiment, recommendedReaction, banglaSceneLabel } = classifySentiment({
    kind,
    caption: sim.visualPreset === 'funny_meme' && !caption ? 'funny meme' : caption,
    quotedSummary: '',
    stickerMeta,
    reactionEmoji: sim.reactionEmoji,
    visual,
    gifPlayback: kind === 'gif',
  });

  const base: Omit<MediaInsight, 'compactContextLine'> = {
    kind,
    isMedia: true,
    isStory,
    isViewOnce: false,
    caption,
    quotedSummary: '',
    stickerMeta,
    durationSec: sim.durationSec,
    reactionEmojiReceived: sim.reactionEmoji,
    visual,
    sentiment,
    recommendedReaction,
    banglaSceneLabel,
    tokensUsedForRead: 0,
  };

  return {
    ...base,
    compactContextLine: buildCompactContextLine(base),
  };
}

function normReply(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function pickUnusedCandidate(candidates: string[], previousReplies: string[]): string {
  const prevSet = new Set(previousReplies.map(normReply));
  for (const c of candidates) {
    if (!prevSet.has(normReply(c))) return c;
  }
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx] || candidates[0];
}

/**
 * Generates contextual, human-like TEXT-ONLY SMS comments & optional like reactions
 * based on 0-token MediaInsight (good/bad/funny/logical/portrait-admiration).
 * Guarantees: 0 API tokens spent AND strictly text-only SMS replies (never sends media back).
 */
export function generateZeroTokenMediaReply(params: {
  insight: MediaInsight;
  context: 'dm' | 'group' | 'story';
  senderName: string;
  tone: AssistantTone;
  ownerName?: string;
  previousReplies?: string[];
}): { replyText: string; reactionEmoji: string; reason: string } {
  const { insight, context, senderName, tone, ownerName = 'Sir', previousReplies = [] } = params;
  const name = senderName && !/^Member\b/i.test(senderName) ? senderName.split(' ')[0] : '';
  const addressPrefix = name ? `${name}, ` : '';
  const isFormal = tone === 'executive_formal';
  const isSharp = tone === 'sharp_shut_down';
  const isDm = context === 'dm';
  const isStory = context === 'story' || insight.isStory;

  let candidates: string[] = [];
  let reaction = insight.recommendedReaction || '👍';

  switch (insight.sentiment) {
    case 'praise_portrait': {
      reaction = '😍';
      if (isFormal) {
        candidates = [
          `${addressPrefix}ছবিটা বেশ সুন্দর ও মার্জিত এসেছে!${isDm ? ` ${ownerName} ফ্রি হলেই দেখবেন।` : ''}`,
          `${addressPrefix}খুবই চমৎকার একটি ছবি! দেখতে দারুণ লাগছে।`,
        ];
      } else if (isStory) {
        candidates = [
          `মাশাআল্লাহ ${name || 'বস'}, স্টোরির ছবিটা দেখতে তো ভীষণ সুন্দর লাগছে! একদম ন্যাচারাল আর কিলার লুক ✨😍`,
          `উফ! দারুণ ফটোজেনিক এসেছে ${name || 'দোস্ত'}—লাইটিং আর এক্সপ্রেশন দুটোই একদম ১০/১০ 🔥✨`,
          `সত্যি বলতে ছবিটা দেখে চোখ আটকে গেল! ভীষণ সুন্দর আর স্টাইলিশ লাগছে দেখতে 😌💫`,
          `কী অসাধারণ লুক! এই স্টোরিটা একদম ফ্রেমে বাঁধিয়ে রাখার মতো সুন্দর হয়েছে 👏✨`,
        ];
      } else if (isDm) {
        candidates = [
          `বাহ ${name || ''}! ছবিটা তো ভীষণ সুন্দর এসেছে, একদম চোখ জুড়ানোর মতো ✨😍 স্যার ফ্রি হয়ে দেখলে নির্ঘাত খুশি হবেন!`,
          `সত্যি বলতে লুক আর ছবির ভাইব দুটোই দারুণ লেগেছে দেখতে 💫😌 স্যারের জন্য সেভ রাখলাম, উনি এলেই দেখবেন।`,
          `একদম ফাটাফাটি ছবি! দেখতে ভীষণ সুন্দর লাগছে—লাইটিং আর অ্যাঙ্গেল দুটোই পারফেক্ট 🔥✨`,
        ];
      } else {
        candidates = [
          `মাশাআল্লাহ ${name || 'ভাই'}, ছবিটা তো দেখতে ভীষণ সুন্দর হয়েছে! একদম হিরো/মডেল ভাইব দিচ্ছো 😍🔥`,
          `আরে বাহ ${name || 'বস'}, এই ছবিতে তোমাকে আসলেই দারুণ লাগছে! একদম পারফেক্ট ক্লিক ✨👏`,
          `এক কথায় অসাধারণ ছবি! লুক, লাইটিং সব মিলিয়ে দেখতে ভীষণ সুন্দর লাগছে 😌💫`,
        ];
      }
      break;
    }

    case 'good_positive': {
      reaction = insight.kind === 'video' ? '🔥' : '❤️';
      if (isFormal) {
        candidates = [
          `${addressPrefix}অত্যন্ত চমৎকার এবং পজিটিভ একটি বিষয় শেয়ার করেছেন—দারুণ লেগেছে!`,
          `${addressPrefix}দেখে খুব ভালো লাগলো! এমন ভালো কন্টেন্ট প্রশংসার যোগ্য।`,
        ];
      } else if (isStory) {
        candidates = [
          `দারুণ হয়েছে ${name || 'ভাই'}! এই স্টোরির ভাইবটা আসলেই মন ভালো করে দেওয়ার মতো 🔥✨`,
          `অসাধারণ! দেখতেও যেমন সুন্দর, অনুভূতিটাও তেমনই পজিটিভ—একদম ১০০/১০০ 👏💯`,
          `জোস একটা স্টোরি! ভালো জিনিস দেখলে মন থেকেই প্রশংসা আসে, দারুণ লাগলো 😍✨`,
        ];
      } else if (isDm) {
        candidates = [
          `বাহ, এটা তো বেশ সুন্দর ও পজিটিভ! ✨ দেখে খুব ভালো লাগলো—স্যার ফিরলেই ওনাকেও দেখাবো।`,
          `দারুণ লেগেছে! এমন সুন্দর মুহূর্ত শেয়ার করার জন্য ধন্যবাদ 😌👏`,
        ];
      } else {
        candidates = [
          `একদম জোস হয়েছে ${name || 'ভাই'}! পজিটিভ আর চমৎকার ভাইব 🔥👏`,
          `ভালো জিনিস ভালো বলতেই হয়—এটা আসলেই দারুণ লেগেছে দেখতে 💯✨`,
        ];
      }
      break;
    }

    case 'bad_critique': {
      reaction = insight.visual?.scene === 'dark_or_unclear' ? '👀' : '😕';
      if (insight.visual?.scene === 'dark_or_unclear') {
        candidates = [
          `${addressPrefix}ছবি বা ভিডিওটা অনেক অন্ধকার ও ঝাপসা আসছে—ভালো করে কিছুই বোঝা যাচ্ছে না! একটু ক্লিয়ার করে দাও তো 👀`,
          `ভাই, এটা তো একদম কালো আর অস্পষ্ট হয়ে গেছে! আলোতে নিয়ে আবার তুলে পাঠাও, নাহলে রিড করা কঠিন হচ্ছে 😕`,
          `কোয়ালিটিটা একদমই ভালো আসেনি—অন্ধকার লাগছে। ক্লিয়ার শট দিলে ঠিকমতো দেখতে পারতাম 👀`,
        ];
      } else if (isSharp) {
        candidates = [
          `${addressPrefix}সোজাসাপ্টা বললে এটা মোটেও ভালো লাগলো না—ব্যাপারটা একদমই জমেনি 😒`,
          `সত্যি বলতে কী, কন্টেন্ট বা পরিস্থিতিটা বেশ নেগেটিভ/দুর্বল লাগছে—আরেকটু বেটার হতে পারতো 💀`,
        ];
      } else {
        candidates = [
          `${addressPrefix}এটা দেখে একটু মন খারাপ বা অস্বস্তি লাগলো—সত্যি বলতে ভালো লাগেনি ব্যাপারটা 😔 কী হয়েছে বলবে?`,
          `আরে! মুড কি বেশিই অফ নাকি ব্যাপারটা আসলেই খারাপ? 😔 খারাপ লাগলে মন খুলে বলতে পারো।`,
          `সত্যি বলতে জিনিসটা একদমই জমেনি—খারাপ হলে তো খারাপ বলতেই হয়! বিষয়টা একটু ঠিক করা দরকার 😕`,
        ];
      }
      break;
    }

    case 'funny_laugh': {
      reaction = '😂';
      if (isFormal) {
        candidates = [
          `হাহা, বেশ মজার ও রসিক ছিল এটা! 😄`,
        ];
      } else if (isStory) {
        candidates = [
          `হাহাহা 😂 ভাই এই স্টোরিটা দেখে হাসি থামাতে পারছি না, একদম সলিড ফানি হয়েছে! 🤣🔥`,
          `ভাই তুমি পুরা কমেডি কিং! স্টোরিতে এটা দেখে দিনটাই ভালো হয়ে গেল 💀😂`,
          `উফফ 😂 কোথায় পাও এসব মজার জিনিস? একদম পারফেক্ট হিউমার! 🤣`,
        ];
      } else {
        candidates = [
          `হাহাহা 😂 একদম কড়া টাইমিংয়ে মারছো ${name || 'বস'}, হাসতে হাসতে অবস্থা খারাপ! 🤣🔥`,
          `ওরে বাবা 🤣 এই স্টিকার/মিমটা দেখে তো জাস্ট উড়ে গেলাম! কোথা থেকে বের করো এসব? 😂`,
          `সিরিয়াসলি ভাই? 💀😂 এই এক জিনিসেই পুরা আড্ডার মুড জমিয়ে দিলা!`,
        ];
      }
      break;
    }

    case 'logical_debate': {
      reaction = '🧠';
      if (insight.visual?.scene === 'screenshot_or_meme') {
        candidates = [
          `${addressPrefix}স্ক্রিনশট/তথ্যটা দেখলাম—তবে এখানে দুই দিকের যুক্তিই খেয়াল করা দরকার। তোমার আসল পয়েন্টটা কী এখানে? 🤔💯`,
          `ইন্টারেস্টিং স্ক্রিনশট! পুরো কনটেক্সট না দেখে হুট করে একমত হওয়া যায় না—তথ্যটা কি যাচাই করা? 👀🧠`,
        ];
      } else {
        candidates = [
          `${addressPrefix}যুক্তিটা শুনতে দারুণ, কিন্তু বাস্তব দিক থেকে ভাবলে এর পাল্টা প্রশ্নও থাকে—তোমার যুক্তির ভিত্তি কী? 🤔`,
          `পয়েন্টটা যথেষ্ট লজিক্যাল লাগলো 💯 তবে মূল বিষয়টা আরেকটু পরিষ্কার করে বললে জমে উঠবে!`,
          `ভালো প্রশ্ন/যুক্তি তুলেছো ${name || 'ভাই'}! যুক্তির কথায় আমি সবসময় ফ্যাক্ট দিয়ে কথা বলতে পছন্দ করি—বিস্তারিত বলো 👀🧠`,
        ];
      }
      break;
    }

    case 'affection_like': {
      reaction = '❤️';
      if (isFormal) {
        candidates = [
          `আপনার আন্তরিক শুভেচ্ছা ও রিয়্যাকশনের জন্য অনেক ধন্যবাদ! 🙏`,
        ];
      } else {
        candidates = [
          `ইশ! এত ভালোবাসা আর মিষ্টি রিয়্যাক্ট দেখলে তো মনটাই ভালো হয়ে যায় ❤️✨ কেমন আছো?`,
          `থ্যাংক ইউ সো মাচ ${name || ''} 🥰 তোমার এই মিষ্টি রেসপন্সটা দারুণ লাগলো!`,
          `উফ, এত পজিটিভ আর কিউট রিয়্যাকশন! 😉❤️ সব ঠিকঠাক চলছে তো?`,
        ];
      }
      break;
    }

    case 'greeting_casual':
    default: {
      reaction = '👍';
      if (insight.kind === 'audio') {
        candidates = isDm
          ? [
              `তোমার ভয়েস নোট (${insight.durationSec || ''}s) পেয়েছি—কী বিষয় ছিল সংক্ষেপে টেক্সটে লিখে দিলে এখনই চটপট হেল্প করতে পারবো! 😊`,
              `অডিও বার্তাটা স্যারের ইনবক্সে সেভ রাখলাম, জরুরি হলে ছোট্ট করে লিখে দাও যেন আমি সাথে সাথে বুঝতে পারি ✨`,
            ]
          : [
              `${addressPrefix}ভয়েস নোট দিলা দেখছি—কী বললা টেক্সটে শর্টে লিখে দিলে এখনই আড্ডা জমে যাবে! 👀`,
            ];
      } else if (insight.kind === 'sticker') {
        candidates = [
          `${addressPrefix}দারুণ স্টিকার তো! 😄 কথাবার্তা কীভাবে চলছে আজ?`,
          `হাহা, শুধু স্টিকার মারলে তো চলবে না ${name || 'বস'}—মুখেও কিছু বলো শুনি! 😉`,
          `স্টিকারটা বেশ ইন্টারেস্টিং ছিল 👀 কী খবর, সব ভালো?`,
        ];
      } else {
        candidates = [
          `${addressPrefix}দেখলাম ব্যাপারটা! বেশ ভালোই লাগলো—তোমার নিজের মতামত কী এটা নিয়ে? ✨`,
          `নজর কেড়েছে কিন্তু! দারুণ শেয়ার করেছো 👍✨`,
        ];
      }
      break;
    }
  }

  const replyText = pickUnusedCandidate(candidates, previousReplies);
  return {
    replyText,
    reactionEmoji: reaction,
    reason: `Zero-Token Local Media Intelligence (${insight.kind} · ${insight.sentiment})`,
  };
}
