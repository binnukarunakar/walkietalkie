import { useState, type JSX } from "react";
import { CreateGroupScreen } from "./components/CreateGroupScreen";
import { GroupLobby } from "./components/GroupLobby";
import { JoinScreen } from "./components/JoinScreen";
import { RadioScreen } from "./components/RadioScreen";
import { useRadioStore } from "./state/store";

interface GroupRoute {
  groupId: string;
  adminKey: string | null;
}

function groupRouteFromUrl(): GroupRoute | null {
  const params = new URLSearchParams(location.search);
  const groupId = params.get("group");
  if (groupId === null || groupId.length < 6) {
    return null;
  }
  // The admin key rides in the fragment, which browsers never send to the
  // server — a query param would land in server request logs.
  const hash = new URLSearchParams(location.hash.slice(1));
  return { groupId, adminKey: hash.get("admin") };
}

export function App(): JSX.Element {
  const phase = useRadioStore((s) => s.phase);
  const [groupRoute, setGroupRoute] = useState<GroupRoute | null>(groupRouteFromUrl);
  const [creating, setCreating] = useState(false);

  if (phase === "join") {
    if (groupRoute !== null) {
      return <GroupLobby groupId={groupRoute.groupId} adminKey={groupRoute.adminKey} />;
    }
    if (creating) {
      return (
        <CreateGroupScreen
          onCreated={(groupId, adminKey) => {
            history.pushState(null, "", `/?group=${encodeURIComponent(groupId)}#admin=${adminKey}`);
            setCreating(false);
            setGroupRoute({ groupId, adminKey });
          }}
          onBack={() => setCreating(false)}
        />
      );
    }
    return <JoinScreen onCreateGroup={() => setCreating(true)} />;
  }
  if (phase === "connecting") {
    return (
      <div className="connecting" data-testid="connecting">
        <p>Tuning…</p>
      </div>
    );
  }
  return <RadioScreen />;
}
