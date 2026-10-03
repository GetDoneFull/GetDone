import { handleListObjectives, handleSubmitObjectives } from "@/lib/control-api/http";

export const dynamic = "force-dynamic";
export const GET = handleListObjectives;
export const POST = handleSubmitObjectives;
