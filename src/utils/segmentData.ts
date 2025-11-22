import { DataCache } from "../../maze-utils/src/cache";
import { getHash, HashedValue } from "../../maze-utils/src/hash";
import Config from "../config";
import * as CompileConfig from "../../config.json";
import { ActionTypes, SponsorSourceType, SponsorTime, VideoID } from "../types";
import { getHashParams } from "./pageUtils";
import { asyncRequestToServer } from "./requests";
import { extensionUserAgent } from "../../maze-utils/src";
import { logRequest, serializeOrStringify } from "../../maze-utils/src/background-request-proxy";

const segmentDataCache = new DataCache<VideoID, SegmentResponse>(() => {
    return {
        segments: null,
        status: 200
    };
}, 5);

const pendingList: Record<VideoID, Promise<SegmentResponse>> = {};

export interface SegmentResponse {
    segments: SponsorTime[] | null;
    status: number | Error | string;
}

// === АВТО-ОБНОВЛЕНИЕ КАЖДЫЕ 30 СЕК ДЛЯ ВИДЕО < 3 ЧАСОВ ===
let autoRefreshInterval: NodeJS.Timeout | null = null;

function startAutoRefreshIfNeeded(videoID: VideoID): void {
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }

    const uploadDateEl = document.querySelector("#date yt-formatted-string") ||
                        document.querySelector("yt-formatted-string.ytd-video-primary-info-renderer");

    if (!uploadDateEl?.textContent) return;

    const text = uploadDateEl.textContent.toLowerCase();

    // Премьеры, стримы, "минут назад", "час назад" — всегда обновляем
    const isFresh = text.includes("премьер") || 
                    text.includes("premier") || 
                    text.includes("live") || 
                    text.includes("стрим") || 
                    /минут|час|секунд/.test(text);

    if (!isFresh) return;

    console.log("[SB Mod] Видео свежее → авто-обновление каждые 30 сек");

    autoRefreshInterval = setInterval(() => {
        console.log("[SB Mod] Авто-обновление сегментов...");

        // Правильный способ сбросить кэш в новой версии maze-utils
        segmentDataCache.delete(videoID);
        delete pendingList[videoID];

        // Принудительно загружаем заново (это вызовет перерисовку баров)
        getSegmentsForVideo(videoID, true);
    }, 30_000);

    // Останавливаем через 40 минут
    setTimeout(() => {
        if (autoRefreshInterval) {
            clearInterval(autoRefreshInterval);
            autoRefreshInterval = null;
            console.log("[SB Mod] Авто-обновление остановлено");
        }
    }, 40 * 60 * 1000);
}

// === ОСНОВНАЯ ФУНКЦИЯ С АВТО-ОБНОВЛЕНИЕМ ===
export async function getSegmentsForVideo(videoID: VideoID, ignoreCache = false): Promise<SegmentResponse> {
    const video = document.querySelector("video") as HTMLVideoElement;
    if (video && !video.paused && !video.ended && !video.seeking) {
        startAutoRefreshIfNeeded(videoID);
    }

    if (!ignoreCache) {
        const cachedData = segmentDataCache.get(videoID);
        if (cachedData) return cachedData;
    }

    if (pendingList[videoID]) {
        return await pendingList[videoID];
    }

    const pendingData = fetchSegmentsForVideo(videoID);
    pendingList[videoID] = pendingData;

    let result: Awaited<typeof pendingData>;
    try {
        result = await pendingData;
    } catch (e) {
        console.error("[SB] Caught error while fetching segments", e);
        return {
            segments: null,
            status: serializeOrStringify(e),
        };
    } finally {
        delete pendingList[videoID];
    }

    return result;
}

// === ЗАГРУЗКА С СЕРВЕРА (БЕЗ ИЗМЕНЕНИЙ) ===
async function fetchSegmentsForVideo(videoID: VideoID): Promise<SegmentResponse> {
    const extraRequestData: Record<string, unknown> = {};
    const hashParams = getHashParams();
    if (hashParams.requiredSegment) extraRequestData.requiredSegment = hashParams.requiredSegment;

    const hashPrefix = (await getHash(videoID, 1)).slice(0, 5) as VideoID & HashedValue;
    const hasDownvotedSegments = !!Config.local.downvotedSegments[hashPrefix.slice(0, 4)];

    const response = await asyncRequestToServer('GET', "/api/skipSegments/" + hashPrefix, {
        categories: CompileConfig.categoryList,
        actionTypes: ActionTypes,
        trimUUIDs: hasDownvotedSegments ? null : 5,
        ...extraRequestData
    }, {
        "X-CLIENT-NAME": extensionUserAgent(),
    });

    if (response.ok) {
        const receivedSegments: SponsorTime[] = JSON.parse(response.responseText)
            ?.filter((video: any) => video.videoID === videoID)
            ?.map((video: any) => video.segments)?.[0]
            ?.map((segment: any) => ({
                ...segment,
                source: SponsorSourceType.Server
            }))
            ?.sort((a: any, b: any) => a.segment[0] - b.segment[0]);

        if (receivedSegments?.length) {
            const result = { segments: receivedSegments, status: response.status };
            segmentDataCache.set(videoID, result);
            return result;
        } else {
            segmentDataCache.set(videoID, { segments: null, status: 200 });
        }
    } else if (response.status !== 404) {
        logRequest(response, "SB", "skip segments");
    }

    return {
        segments: null,
        status: response.status
    };
}