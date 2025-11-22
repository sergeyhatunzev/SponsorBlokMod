import { DataCache } from "../../maze-utils/src/cache";
import { getHash, HashedValue } from "../../maze-utils/src/hash";
import Config from "../config";
import * as CompileConfig from "../../config.json";
import { ActionTypes, SponsorSourceType, SponsorTime, VideoID } from "../types";
import { getHashParams } from "./pageUtils";
import { asyncRequestToServer } from "./requests";
import { extensionUserAgent } from "../../maze-utils/src";
import { logRequest, serializeOrStringify } from "../../maze-utils/src/background-request-proxy";

// Кэш и очередь запросов
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

// === АВТО-ОБНОВЛЕНИЕ СЕГМЕНТОВ КАЖДЫЕ 30 СЕКУНД (ТОЛЬКО ДЛЯ ВИДЕО < 3 ЧАСОВ) ===
let autoRefreshInterval: NodeJS.Timeout | null = null;

function startAutoRefreshIfNeeded(videoID: VideoID): void {
    // Сбрасываем старый интервал
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
    }

    const uploadDateEl = document.querySelector("#date yt-formatted-string")
        || document.querySelector("yt-formatted-string.ytd-video-primary-info-renderer");

    if (!uploadDateEl?.textContent) return;

    const text = uploadDateEl.textContent.trim().toLowerCase();

    // Премьеры и стримы — всегда считаем свежими
    if (text.includes("премьер") || text.includes("premier") || text.includes("live") || text.includes("стрим")) {
        launchAutoRefresh();
        return;
    }

    // Если написано "минут назад", "час назад" и т.д. — парсим
    const now = Date.now();
    let uploadTime = now;

    if (text.includes("секунд") || text.includes("минут") || (text.includes("час") && /1|2|3/.test(text))) {
        launchAutoRefresh();
        return;
    }

    // Попробуем через встроенный парсер (если есть)
    try {
        // @ts-ignore — может быть в maze-utils
        if ((window as any).GenericUtils?.parseYouTubeUploadDate) {
            const parsed = (window as any).GenericUtils.parseYouTubeUploadDate(uploadDateEl.textContent);
            if (parsed) {
                const hoursAgo = (now - parsed.getTime()) / (1000 * 60 * 60);
                if (hoursAgo < 3) {
                    launchAutoRefresh();
                }
                return;
            }
        }
    } catch (_) { /* игнорируем */ }

    function launchAutoRefresh(): void {
        console.log("[SponsorBlock Mod] Видео свежее → авто-обновление каждые 30 сек");

        autoRefreshInterval = setInterval(() => {
            console.log("[SponsorBlock Mod] Авто-обновление сегментов...");
            // Принудительно чистим кэш и делаем новый запрос
            segmentDataCache.removeFromCache(videoID);
            delete pendingList[videoID];

            // Это вызовет перерисовку баров автоматически
            getSegmentsForVideo(videoID, true);
        }, 30_000);

        // Останавливаем через 40 минут (хватит даже для самых долгих премьер)
        setTimeout(() => {
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
                console.log("[SponsorBlock Mod] Авто-обновление остановлено (40 мин прошло)");
            }
        }, 40 * 60 * 1000);
    }
}

// === ОСНОВНАЯ ФУНКЦИЯ (МОДИФИЦИРОВАННАЯ) ===
export async function getSegmentsForVideo(videoID: VideoID, ignoreCache = false): Promise<SegmentResponse> {
    // Запускаем авто-обновление, если видео играет и свежее
    const video = document.querySelector("video") as HTMLVideoElement;
    if (video && !video.paused && !video.ended && !video.seeking) {
        startAutoRefreshIfNeeded(videoID);
    }

    // Остальная логика — как была
    if (!ignoreCache) {
        const cachedData = segmentDataCache.getFromCache(videoID);
        if (cachedData) {
            segmentDataCache.cacheUsed(videoID);
            return cachedData;
        }
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

// === ОРИГИНАЛЬНАЯ ФУНКЦИЯ ЗАГРУЗКИ (БЕЗ ИЗМЕНЕНИЙ) ===
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

        if (receivedSegments && receivedSegments.length) {
            const result = {
                segments: receivedSegments,
                status: response.status
            };
            segmentDataCache.setupCache(videoID).segments = result.segments;
            return result;
        } else {
            segmentDataCache.setupCache(videoID);
        }
    } else if (response.status !== 404) {
        logRequest(response, "SB", "skip segments");
    }

    return {
        segments: null,
        status: response.status
    };
}