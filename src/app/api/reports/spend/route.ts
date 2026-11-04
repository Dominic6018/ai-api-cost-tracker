import { reportDeps } from "../deps";
import { createSpendReportHandler } from "../handlers";

export const dynamic = "force-dynamic";
export const GET = createSpendReportHandler(reportDeps);
