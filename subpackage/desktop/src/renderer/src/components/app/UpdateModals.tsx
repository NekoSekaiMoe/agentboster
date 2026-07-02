import { t } from "../../i18n";
import { CloseIconButton } from "../ui/IconButton";

export function UpdateErrorModal(props: {
  message: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-error-modal">
        <div className="modal-header">
          <strong>{t("update.checkFailedTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.checkFailedDescription")}
          </p>
          <div className="update-error-detail">
            {t("update.errorInfo", { message: props.message })}
          </div>
          <p className="update-asset-line">
            {t("update.manualReleaseHint")}
            <br />
            <span>{props.releasesUrl}</span>
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button className="primary" onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}

export function UpToDateModal(props: {
  version: string;
  releasesUrl: string;
  onClose: () => void;
  onOpenRelease: () => void;
}) {
  return (
    <div className="modal-backdrop update-backdrop">
      <section className="update-modal update-uptodate-modal">
        <div className="modal-header">
          <strong>{t("update.upToDateTitle")}</strong>
          <CloseIconButton label={t("common.close")} onClick={props.onClose} />
        </div>
        <div className="update-body">
          <p className="update-version-line">
            {t("update.upToDateMessage", { version: props.version })}
          </p>
        </div>
        <div className="update-actions">
          <button onClick={props.onClose}>{t("common.close")}</button>
          <button onClick={props.onOpenRelease}>
            {t("update.openReleasePage")}
          </button>
        </div>
      </section>
    </div>
  );
}
