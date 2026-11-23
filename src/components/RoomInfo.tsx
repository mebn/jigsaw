import { useState } from "react";
import type { RoomSummary } from "../../shared/protocol.ts";
import { formatDuration, plural } from "../lib/format.ts";
import { navigate, paths } from "../lib/router.ts";
import Dialog from "./Dialog.tsx";

const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
const shapeName = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : "");

// A jigsaw's window from the i button on the jigsaws page: its picture and what there is to know
// about it, who made it among them. The thumbnail shows at once, the full picture over it once loaded.
interface RoomInfoProps {
  r: RoomSummary;
  onClose: () => void;
  closing: boolean;
}

export default function RoomInfo({ r, onClose, closing }: RoomInfoProps) {
  const [full, setFull] = useState(false);
  const aspect = r.width > 0 && r.height > 0 ? r.width / r.height : 4 / 3;
  const rows: [string, string][] = [
    ["Made by", r.ownerName ?? "Unknown"],
    ["Made on", day(r.created)],
    ["Pieces", `${r.n} (${r.cols} × ${r.rows})`],
    ...(r.shape ? [["Shape", shapeName(r.shape)] as [string, string]] : []),
    ...(r.done
      ? [
          ["Finished", r.finished > 0 ? day(r.finished) : "Yes"] as [
            string,
            string,
          ],
          ["Time it took", formatDuration(r.seconds)] as [string, string],
        ]
      : [
          ["Progress", `${Math.round(r.progress * 100)}% done`] as [
            string,
            string,
          ],
          ...(r.seconds > 0
            ? [["Time so far", formatDuration(r.seconds)] as [string, string]]
            : []),
          ...(r.online
            ? [["Playing now", plural(r.online, "player")] as [string, string]]
            : []),
        ]),
    [
      "Visibility",
      r.private ? "Private: only people with the link can join" : "Public",
    ],
  ];

  return (
    <Dialog
      title="About this jigsaw"
      className="room-info"
      onClose={onClose}
      closing={closing}
    >
      <div className="room-info-pic" style={{ aspectRatio: String(aspect) }}>
        {r.thumb && <img src={r.thumb} alt="" draggable={false} />}
        <img
          src={`/api/rooms/${r.id}/image`}
          alt="The jigsaw's picture"
          draggable={false}
          className={full ? "on" : ""}
          onLoad={() => setFull(true)}
        />
      </div>
      <dl className="room-info-rows">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="row modal-actions">
        <button
          className="primary"
          onClick={() => {
            onClose();
            navigate(paths.room(r.id));
          }}
        >
          {r.done ? "Open" : "Play"}
        </button>
      </div>
    </Dialog>
  );
}
