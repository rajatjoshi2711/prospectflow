"use server";

import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { setSessionCookie, clearSessionCookie } from "@/lib/auth/session";
import { getEmailDomain } from "@/lib/auth/org";
import { loginSchema, signupSchema } from "@/lib/auth/schemas";

export type AuthFormState = {
  error?: string;
} | null;

export async function signUpAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = signupSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { name, email, password } = parsed.data;
  const domain = getEmailDomain(email);

  let userId: string;
  let organizationId: string;
  let role: "ADMIN" | "MEMBER";

  try {
    const passwordHash = await hashPassword(password);

    const result = await prisma.$transaction(async (tx) => {
      const existingOrg = await tx.organization.findUnique({
        where: { emailDomain: domain },
      });

      const organization =
        existingOrg ??
        (await tx.organization.create({
          data: {
            name: domain.split(".")[0]
              ? domain.split(".")[0].charAt(0).toUpperCase() +
                domain.split(".")[0].slice(1)
              : domain,
            emailDomain: domain,
          },
        }));

      const isFirstUserInOrg = !existingOrg;

      const user = await tx.user.create({
        data: {
          name,
          email,
          passwordHash,
          organizationId: organization.id,
          role: isFirstUserInOrg ? "ADMIN" : "MEMBER",
        },
      });

      return { user, organization };
    });

    userId = result.user.id;
    organizationId = result.organization.id;
    role = result.user.role;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { error: "An account with that email already exists." };
    }
    console.error("Signup failed:", err);
    return { error: "Something went wrong. Please try again." };
  }

  await setSessionCookie({
    userId,
    organizationId,
    role,
    email,
    name,
  });

  redirect("/dashboard");
}

export async function logInAction(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { error: "Incorrect email or password." };
  }

  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) {
    return { error: "Incorrect email or password." };
  }

  await setSessionCookie({
    userId: user.id,
    organizationId: user.organizationId,
    role: user.role,
    email: user.email,
    name: user.name,
  });

  redirect("/dashboard");
}

export async function logOutAction() {
  await clearSessionCookie();
  redirect("/login");
}
