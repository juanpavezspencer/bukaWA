"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "./api";

/** Load an admin endpoint; "out" when the admin session is missing or expired. */
export function useAdmin<T>(path: string, version = 0): T | "loading" | "out" | Error {
  const [state, setState] = useState<T | "loading" | "out" | Error>("loading");
  useEffect(() => {
    api<T>(path)
      .then(setState)
      .catch((e) => setState(e instanceof ApiError && e.status === 401 ? "out" : e));
  }, [path, version]);
  return state;
}
