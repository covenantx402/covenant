import type { UsageEvent } from "./types.js";
export declare class UsageLogger {
    private db;
    private insertStmt;
    constructor(dbPath: string);
    log(event: UsageEvent): void;
    getSummary(sinceMs?: number): {
        totalRequests: number;
        paidRequests: number;
        rejectedRequests: number;
        totalRevenueUsd: string;
        uniquePayers: number;
        routes: Array<{
            route: string;
            method: string;
            count: number;
            revenueUsd: string;
        }>;
    };
    recentEvents(limit?: number): UsageEvent[];
    close(): void;
}
