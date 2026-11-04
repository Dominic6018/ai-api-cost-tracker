import { reportDeps } from "../deps";
import { createUsageReportHandler } from "../handlers";

export const dynamic = "force-dynamic";
export const GET = createUsageReportHandler(reportDeps);
