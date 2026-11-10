import { reservationDeps } from "../deps";
import { createReleaseHandler } from "../reservations";

export const POST = createReleaseHandler(reservationDeps);
