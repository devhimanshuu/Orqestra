"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client. Talks to /api/auth/* on the same origin —
 * no provider SDK details leak into UI components beyond this module.
 */
export const authClient = createAuthClient();
