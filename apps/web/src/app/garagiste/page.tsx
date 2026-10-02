import { redirect } from "next/navigation";

/**
 * /garagiste was the portal's sign-in page before every space got a /login door.
 * The address was given to garages, so it keeps working: it leads to the door,
 * which forwards a garage already signed in to its dashboard.
 */
export default function GaragisteIndexPage() {
  redirect("/garagiste/login");
}
