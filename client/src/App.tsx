import type { JSX } from "react";
import { JoinScreen } from "./components/JoinScreen";
import { RadioScreen } from "./components/RadioScreen";
import { radio } from "./lib/radio";
import { useRadioStore } from "./state/store";

export function App(): JSX.Element {
  const phase = useRadioStore((s) => s.phase);

  if (phase === "join") {
    return <JoinScreen />;
  }
  if (phase === "connecting") {
    return (
      <div className="connecting" data-testid="connecting">
        <p>Tuning…</p>
        <button type="button" data-testid="cancel-button" onClick={() => radio.leave()}>
          Cancel
        </button>
      </div>
    );
  }
  return <RadioScreen />;
}
