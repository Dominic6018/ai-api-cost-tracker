import { reservationDeps } from "../deps";
import { createReserveHandler } from "../reservations";

export const POST = createReserveHandler(reservationDeps);
