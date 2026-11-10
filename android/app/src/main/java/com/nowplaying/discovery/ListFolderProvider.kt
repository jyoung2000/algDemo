package com.nowplaying.discovery

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.provider.DocumentsContract
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException

/**
 * LIST-FOLDER-001: the "Airwave Discovery" place in the Files app. It holds one folder, the song list
 * the owner last opened from the app, with its downloaded songs in play order. Read-only: the files
 * are the app's own downloads, served from where they already are.
 */
class ListFolderProvider : DocumentsProvider() {
  override fun onCreate(): Boolean = true

  private val rootCols = arrayOf(Root.COLUMN_ROOT_ID, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_FLAGS, Root.COLUMN_ICON)
  private val docCols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE, Document.COLUMN_FLAGS, Document.COLUMN_LAST_MODIFIED)

  override fun queryRoots(projection: Array<out String>?): Cursor {
    val c = MatrixCursor(projection ?: rootCols)
    val listing = ListFolder.read(context!!)
    c.newRow()
      .add(Root.COLUMN_ROOT_ID, ListFolder.ROOT)
      .add(Root.COLUMN_DOCUMENT_ID, ListFolder.DIR)
      .add(Root.COLUMN_TITLE, "Airwave Discovery")
      .add(Root.COLUMN_SUMMARY, listing?.name ?: "Open a song list from the app")
      .add(Root.COLUMN_FLAGS, Root.FLAG_LOCAL_ONLY)
      .add(Root.COLUMN_ICON, R.mipmap.ic_launcher)
    c.setNotificationUri(context!!.contentResolver, DocumentsContract.buildRootsUri(ListFolder.AUTHORITY))
    return c
  }

  override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
    val c = MatrixCursor(projection ?: docCols)
    val listing = ListFolder.read(context!!)
    if (documentId == ListFolder.DIR) dirRow(c, listing?.name ?: "Airwave Discovery")
    else songRow(c, documentId, entry(documentId, listing))
    return c
  }

  override fun queryChildDocuments(parentDocumentId: String, projection: Array<out String>?, sortOrder: String?): Cursor {
    val c = MatrixCursor(projection ?: docCols)
    if (parentDocumentId == ListFolder.DIR) {
      ListFolder.read(context!!)?.entries?.forEachIndexed { i, e -> songRow(c, "song:$i", e) }
    }
    c.setNotificationUri(context!!.contentResolver, DocumentsContract.buildChildDocumentsUri(ListFolder.AUTHORITY, ListFolder.DIR))
    return c
  }

  override fun openDocument(documentId: String, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
    if (mode != "r") throw FileNotFoundException("These songs are read-only.")
    val e = entry(documentId, ListFolder.read(context!!))
    return if (e.uri.scheme == "file") ParcelFileDescriptor.open(File(e.uri.path ?: throw FileNotFoundException(documentId)), ParcelFileDescriptor.MODE_READ_ONLY)
    else context!!.contentResolver.openFileDescriptor(e.uri, "r") ?: throw FileNotFoundException(documentId)
  }

  override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean =
    parentDocumentId == ListFolder.DIR && documentId.startsWith("song:")

  private fun entry(id: String, listing: ListFolder.Listing?): ListFolder.Entry {
    val i = id.removePrefix("song:").toIntOrNull()
    return listing?.entries?.getOrNull(i ?: -1) ?: throw FileNotFoundException(id)
  }

  private fun dirRow(c: MatrixCursor, name: String) {
    c.newRow().add(Document.COLUMN_DOCUMENT_ID, ListFolder.DIR).add(Document.COLUMN_DISPLAY_NAME, name)
      .add(Document.COLUMN_MIME_TYPE, Document.MIME_TYPE_DIR).add(Document.COLUMN_SIZE, null).add(Document.COLUMN_FLAGS, 0)
      .add(Document.COLUMN_LAST_MODIFIED, null)
  }

  private fun songRow(c: MatrixCursor, id: String, e: ListFolder.Entry) {
    c.newRow().add(Document.COLUMN_DOCUMENT_ID, id).add(Document.COLUMN_DISPLAY_NAME, e.name)
      .add(Document.COLUMN_MIME_TYPE, e.mime).add(Document.COLUMN_SIZE, if (e.size >= 0) e.size else null)
      .add(Document.COLUMN_FLAGS, 0).add(Document.COLUMN_LAST_MODIFIED, null)
  }
}
