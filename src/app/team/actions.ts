"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { changeAccountRole } from "@/db/accounts";
import { audited, userActor } from "@/db/audit";
import { roleChangedEntry } from "@/lib/audit";
import { requirePermission } from "@/lib/auth";
import { parseRole, type TeamStatus } from "@/lib/team";

// Server actions can be called from any route, so this checks the session
// and role itself, and changes only accounts in the admin's organization.
export async function changeRoleAction(
  userId: string,
  formData: FormData,
): Promise<void> {
  const user = await requirePermission("team:manage");
  const role = parseRole(formData.get("role"));
  let status: TeamStatus = "invalid_role";
  if (role) {
    const result = await audited(db, userActor(user), async (tx) => {
      const changed = await changeAccountRole(tx, {
        organizationId: user.organizationId,
        userId,
        role,
      });
      return {
        result: changed,
        entry: changed.ok ? roleChangedEntry(changed) : null,
      };
    });
    status = !result.ok
      ? result.error
      : result.previousRole === result.role
        ? "unchanged"
        : "changed";
  }
  revalidatePath("/team");
  // An admin who made themselves a member is sent on to /no-access.
  redirect(`/team?status=${status}`);
}
