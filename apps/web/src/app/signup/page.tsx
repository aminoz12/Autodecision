import { redirect } from "next/navigation";

/** The owner signup lives in the admin space: /admin/signup. */
export default function SignupRedirect() {
  redirect("/admin/signup");
}
