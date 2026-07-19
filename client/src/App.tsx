import { useState, type JSX } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CreateGroupScreen } from "./components/CreateGroupScreen";
import { GroupLobby } from "./components/GroupLobby";
import { JoinScreen } from "./components/JoinScreen";
import { RadioScreen } from "./components/RadioScreen";
import { rise } from "./lib/motion";
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

  const screen = (): { key: string; node: JSX.Element } => {
    if (phase === "join") {
      if (groupRoute !== null) {
        return {
          key: `lobby-${groupRoute.groupId}`,
          node: <GroupLobby groupId={groupRoute.groupId} adminKey={groupRoute.adminKey} />,
        };
      }
      if (creating) {
        return {
          key: "create",
          node: (
            <CreateGroupScreen
              onCreated={(groupId, adminKey) => {
                history.pushState(
                  null,
                  "",
                  `/?group=${encodeURIComponent(groupId)}#admin=${adminKey}`,
                );
                setCreating(false);
                setGroupRoute({ groupId, adminKey });
              }}
              onBack={() => setCreating(false)}
            />
          ),
        };
      }
      return { key: "join", node: <JoinScreen onCreateGroup={() => setCreating(true)} /> };
    }
    if (phase === "connecting") {
      return {
        key: "connecting",
        node: (
          <div className="connecting" data-testid="connecting">
            <span className="connecting-dot" aria-hidden="true" />
            <p>Tuning…</p>
          </div>
        ),
      };
    }
    return { key: "radio", node: <RadioScreen /> };
  };

  const { key, node } = screen();
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={key}
        className="screen"
        variants={rise}
        initial="hidden"
        animate="visible"
        exit="exit"
      >
        {node}
      </motion.div>
    </AnimatePresence>
  );
}
