<template>
  <modals-modal v-model="show" name="bookmark-import" :width="640" :height="'unset'" :processing="applying">
    <div v-if="show" class="w-full rounded-lg bg-bg box-shadow-md relative overflow-hidden" style="max-height: 80vh">
      <div class="px-5 py-4 border-b border-white/10">
        <h2 class="text-xl font-semibold">{{ $strings.LabelImportBookmarks }}</h2>
      </div>
      <div class="max-h-[60vh] overflow-y-auto px-5 py-4">
        <div v-if="!preview">
          <ui-file-input accept=".json,application/json" @change="selectFile">{{ $strings.LabelSelectBookmarkFile }}</ui-file-input>
          <p v-if="selectedFileName" class="mt-3 text-sm text-gray-300">{{ selectedFileName }}</p>
        </div>
        <div v-else>
          <section v-if="preview.newBookmarks.length" class="mb-5">
            <h3 class="mb-2 font-semibold">{{ $strings.LabelNewBookmarks }} ({{ preview.newBookmarks.length }})</h3>
            <ul class="divide-y divide-white/10">
              <li v-for="bookmark in preview.newBookmarks" :key="`new-${bookmark.time}`" class="flex gap-4 py-2 text-sm">
                <span class="w-16 shrink-0 font-mono text-gray-400">{{ formatTime(bookmark.time) }}</span>
                <span class="break-words">{{ bookmark.title }}</span>
              </li>
            </ul>
          </section>
          <section v-if="preview.conflicts.length">
            <h3 class="mb-2 font-semibold">{{ $strings.LabelConflictingBookmarks }} ({{ preview.conflicts.length }})</h3>
            <div v-for="conflict in preview.conflicts" :key="`conflict-${conflict.imported.time}`" class="border-t border-white/10 py-3">
              <p class="mb-2 font-mono text-sm text-gray-400">{{ formatTime(conflict.imported.time) }}</p>
              <label class="flex items-start gap-2 py-1 text-sm">
                <input v-model="conflictChoices[String(conflict.imported.time)]" type="radio" :name="`bookmark-${conflict.imported.time}`" value="keep" />
                <span>{{ $strings.LabelKeepExisting }}: {{ conflict.existing.title }}</span>
              </label>
              <label class="flex items-start gap-2 py-1 text-sm">
                <input v-model="conflictChoices[String(conflict.imported.time)]" type="radio" :name="`bookmark-${conflict.imported.time}`" value="replace" />
                <span>{{ $strings.LabelReplaceWith }}: {{ conflict.imported.title }}</span>
              </label>
            </div>
          </section>
          <p v-if="!preview.newBookmarks.length && !preview.conflicts.length" class="text-sm text-gray-300">{{ $strings.MessageNoBookmarkChanges }}</p>
        </div>
      </div>
      <div class="flex justify-end gap-2 border-t border-white/10 px-5 py-4">
        <ui-btn @click="cancel">{{ $strings.ButtonCancel }}</ui-btn>
        <ui-btn v-if="preview" color="bg-success" :disabled="applying || (!preview.newBookmarks.length && !hasReplacements)" :loading="applying" @click="applyImport">{{ $strings.ButtonImport }}</ui-btn>
      </div>
    </div>
  </modals-modal>
</template>

<script>
export default {
  props: {
    value: Boolean,
    libraryItemId: String
  },
  data() {
    return {
      bookmarkFile: null,
      selectedFileName: '',
      preview: null,
      conflictChoices: {},
      applying: false
    }
  },
  computed: {
    show: {
      get() {
        return this.value
      },
      set(value) {
        this.$emit('input', value)
      }
    },
    hasReplacements() {
      return Object.values(this.conflictChoices).some((choice) => choice === 'replace')
    }
  },
  watch: {
    value(value) {
      if (!value) this.reset()
    }
  },
  methods: {
    async selectFile(file) {
      // Keep the chosen name visible while parsing and previewing the file.
      this.selectedFileName = file.name
      try {
        // Parse the selected JSON locally, then request a read-only server preview.
        this.bookmarkFile = JSON.parse(await file.text())
        this.preview = await this.$axios.$post(`/api/me/item/${this.libraryItemId}/bookmarks/import`, {
          action: 'preview',
          bookmarkFile: this.bookmarkFile
        })
        // Default each conflict to keeping the existing bookmark until the user changes it.
        this.conflictChoices = {}
        for (const conflict of this.preview.conflicts) {
          this.$set(this.conflictChoices, String(conflict.imported.time), 'keep')
        }
      } catch (error) {
        // Leave the modal ready for another selection if parsing or preview validation fails.
        this.preview = null
        this.bookmarkFile = null
        this.$toast.error(this.$strings.ToastImportBookmarksFailed)
        console.error('Failed to preview bookmark import', error)
      }
    },
    formatTime(time) {
      return this.$secondsToTimestamp(time)
    },
    async applyImport() {
      this.applying = true
      try {
        // Submit the original validated file and the user's explicit conflict decisions.
        await this.$axios.$post(`/api/me/item/${this.libraryItemId}/bookmarks/import`, {
          action: 'apply',
          bookmarkFile: this.bookmarkFile,
          conflictChoices: this.conflictChoices
        })
        this.$toast.success(this.$strings.ToastImportBookmarksSuccess)
        this.show = false
      } catch (error) {
        this.$toast.error(this.$strings.ToastImportBookmarksFailed)
        console.error('Failed to apply bookmark import', error)
      } finally {
        this.applying = false
      }
    },
    cancel() {
      // Closing before apply discards the preview without changing server state.
      this.show = false
    },
    reset() {
      // Clear transient file and choice state when the modal closes.
      this.bookmarkFile = null
      this.selectedFileName = ''
      this.preview = null
      this.conflictChoices = {}
      this.applying = false
    }
  }
}
</script>