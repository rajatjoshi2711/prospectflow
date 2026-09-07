import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth/guards";
import { firstIssue } from "@/lib/matching/schemas";
import { runChatTurn } from "@/lib/prospect-ask/agent";

/**
 * One ProspectAsk turn.
 *
 * SCOPING: `ToolScope` is built HERE, from the verified session, and is the only
 * source of tenancy for the whole tool-calling loop. `conversationId` comes from
 * the client, but it is never trusted as an authorization boundary — every read
 * and write of `ChatMessage` is filtered by `userId` as well, so posting into a
 * conversation id belonging to another member creates a new, separate thread for
 * the caller rather than joining theirs.
 *
 * A tool-calling turn can take a while (several model round trips), so this runs
 * on the Node runtime with a raised duration cap.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

const bodySchema = z.object({
  message: z.string().trim().min(1, "Ask a question.").max(2_000),
  /**
   * Client-generated conversation id. Constrained so it cannot be used to smuggle
   * anything into a query or a log line.
   */
  conversationId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/, "Invalid conversation id.")
    .optional(),
});

export async function POST(request: Request) {
  const guard = await requireSession();
  if (!guard.ok) return guard.response;

  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }

  const conversationId = parsed.data.conversationId ?? crypto.randomUUID();

  try {
    const result = await runChatTurn({
      scope: {
        userId: guard.session.userId,
        organizationId: guard.session.organizationId,
      },
      conversationId,
      question: parsed.data.message,
    });

    return NextResponse.json({
      conversationId: result.conversationId,
      answer: result.answer,
      // The tool names are surfaced so the UI can show what the answer was built
      // from — grounding the reader, not just the model.
      toolCalls: result.toolCalls.map((call) => ({ name: call.name, ok: call.ok })),
      degraded: result.degraded,
    });
  } catch (error) {
    console.error("ProspectAsk turn failed", error);
    return NextResponse.json(
      { error: "Something went wrong answering that. Try again." },
      { status: 500 },
    );
  }
}
