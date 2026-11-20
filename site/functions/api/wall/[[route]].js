// Every /api/wall/* request. The logic, and the reasons for it, live in
// functions/_wall/wall.js, which exports no onRequest so Pages does not route it.
import { handle } from "../../_wall/wall.js";

export const onRequest = (context) => handle(context.request, context.env);
