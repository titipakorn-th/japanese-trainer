import { StartCard } from "./StartCard";
import { IZAKAYA } from "@/server/sessions";

export default function StartPage() {
  return <StartCard goal={IZAKAYA.goal} />;
}
