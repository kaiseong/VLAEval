/**
 * Raw result exports are server downloads (an `<a download>` to /api/jobs/<id>/result.json or traces.csv), not
 * Blobs made in the page. Evaluate this after a scenario installs its URL.createObjectURL recorder: such a click then
 * fetches the same URL and passes the response to URL.createObjectURL, so the recorder captures the downloaded
 * bytes. The real save is skipped. `window.__serverDownload` settles once the recorder has the entry.
 */
export const recordServerDownloads = `(()=>{
  const click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    if(!this.download||this.href.startsWith("blob:"))return click.call(this);
    window.__serverDownload=fetch(this.href).then((response)=>{
      if(!response.ok)throw new Error("Server download failed: HTTP "+response.status);
      return response.blob();
    }).then((blob)=>{URL.createObjectURL(blob);return true});
  };
  return true;
})()`;
