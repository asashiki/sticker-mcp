import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";

// Initialize the MCP App client
const app = new App({
  name: "sticker-admin-ui",
  version: "1.0.0"
});

async function main() {
  try {
    // Connect to the host (Claude Desktop or other compatible host)
    await app.connect(new PostMessageTransport(window.parent, window.parent));
    console.log("Connected to MCP Host");
  } catch (error) {
    console.error("Failed to connect to MCP Host:", error);
    // Continue anyway in case we are testing outside a host, though callTool will fail
  }

  const dropZone = document.getElementById("drop-zone") as HTMLDivElement;
  const fileInput = document.getElementById("file-input") as HTMLInputElement;
  const previewImg = document.getElementById("preview-img") as HTMLImageElement;
  const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
  const nameInput = document.getElementById("sticker-name") as HTMLInputElement;
  const tagsInput = document.getElementById("sticker-tags") as HTMLInputElement;
  const gallery = document.getElementById("gallery") as HTMLDivElement;
  
  const adminView = document.getElementById("admin-view") as HTMLDivElement;
  const displayView = document.getElementById("display-view") as HTMLDivElement;
  const displayImg = document.getElementById("display-img") as HTMLImageElement;
  const displayError = document.getElementById("display-error") as HTMLHeadingElement;

  // UI routing based on host context
  function checkRoute() {
    const context = app.getHostContext();
    const toolName = context?.toolInfo?.tool?.name;
    
    if (toolName === "send_sticker") {
      adminView.style.display = "none";
      displayView.style.display = "flex";
      document.body.style.background = "transparent";
      document.body.style.backgroundColor = "transparent";
      // We will listen to ontoolinput to get the actual arguments
    } else {
      adminView.style.display = "block";
      displayView.style.display = "none";
      loadStickers();
    }
  }
  
  app.ontoolinput = async (params) => {
    const context = app.getHostContext();
    if (context?.toolInfo?.tool?.name === "send_sticker") {
      const emotion = params.arguments?.emotion as string;
      if (emotion) {
        try {
          const result = await (app as any).callServerTool({
            name: "_admin_manage_stickers",
            arguments: { action: "get_by_emotion", emotion }
          });
          const content = result.content[0] as { text: string };
          const stickerData = JSON.parse(content.text);
          if (stickerData && stickerData.base64Data) {
            displayImg.src = `data:${stickerData.mimeType};base64,${stickerData.base64Data}`;
            displayImg.style.display = "block";
            displayError.style.display = "none";
          } else {
            displayImg.style.display = "none";
            displayError.style.display = "block";
            displayError.textContent = `No sticker found for: ${emotion}`;
          }
        } catch (e: any) {
          console.error("Failed to load sticker", e);
          displayImg.style.display = "none";
          displayError.style.display = "block";
          displayError.textContent = `Error: ${e.message || "Unknown error"}`;
        }
      }
    }
  };

  // Check initial route
  checkRoute();

  let currentFileBase64 = "";
  let currentMimeType = "";

  // Handle Drag and Drop
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });
  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer?.files.length) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", (e) => {
    if (fileInput.files?.length) {
      handleFile(fileInput.files[0]);
    }
  });

  function handleFile(file: File) {
    if (!file.type.startsWith("image/")) {
      alert("Please upload an image file");
      return;
    }

    currentMimeType = file.type;
    const reader = new FileReader();
    reader.onload = (e) => {
      currentFileBase64 = e.target?.result as string;
      previewImg.src = currentFileBase64;
      previewImg.style.display = "block";
      updateAddButtonState();
    };
    reader.readAsDataURL(file);
  }

  function updateAddButtonState() {
    addBtn.disabled = !currentFileBase64 || !nameInput.value.trim() || !tagsInput.value.trim();
  }

  nameInput.addEventListener("input", updateAddButtonState);
  tagsInput.addEventListener("input", updateAddButtonState);

  // Load Stickers
  async function loadStickers() {
    try {
      const result = await app.callTool({
        name: "_admin_manage_stickers",
        arguments: { action: "list" }
      });
      
      const content = result.content[0] as { text: string };
      const stickers = JSON.parse(content.text);
      renderGallery(stickers);
    } catch (e) {
      console.error("Failed to load stickers", e);
    }
  }

  function renderGallery(stickers: any[]) {
    gallery.innerHTML = "";
    stickers.forEach(sticker => {
      const card = document.createElement("div");
      card.className = "sticker-card";
      
      // We don't have the image data directly in the list, so we might need to fetch it
      // For this simple UI, we'll assume the host can fetch file:// paths if we used absolute paths,
      // but standard browsers can't load local files easily.
      // To solve this, we can store a thumbnail or use another tool to get the image base64,
      // but for simplicity, we'll just show the metadata.
      // Actually, a better approach is to have a tool that returns base64 for an image, or embed it in the list.
      // Since it's local, we can just show a placeholder or name.
      
      card.innerHTML = `
        <div class="sticker-info">
          <p class="sticker-name">${escapeHtml(sticker.name)}</p>
          <p class="sticker-tags">${escapeHtml(sticker.emotions.join(", "))}</p>
        </div>
        <button class="delete-btn" data-id="${sticker.id}">&times;</button>
      `;
      
      card.querySelector(".delete-btn")?.addEventListener("click", async () => {
        if (confirm("Delete this sticker?")) {
          await app.callTool({
            name: "_admin_manage_stickers",
            arguments: { action: "delete", id: sticker.id }
          });
          loadStickers();
        }
      });

      gallery.appendChild(card);
    });
  }

  function escapeHtml(unsafe: string) {
    return unsafe
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
  }

  // Add Sticker
  addBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const emotions = tagsInput.value.split(",").map(s => s.trim()).filter(s => s);
    
    addBtn.disabled = true;
    addBtn.textContent = "Adding...";
    
    try {
      await app.callTool({
        name: "_admin_manage_stickers",
        arguments: {
          action: "add",
          name,
          emotions,
          base64Data: currentFileBase64,
          mimeType: currentMimeType
        }
      });
      
      // Reset form
      nameInput.value = "";
      tagsInput.value = "";
      currentFileBase64 = "";
      currentMimeType = "";
      previewImg.style.display = "none";
      updateAddButtonState();
      
      loadStickers();
    } catch (e) {
      console.error("Failed to add sticker", e);
      alert("Failed to add sticker. Check console.");
    } finally {
      addBtn.textContent = "Add Sticker";
      updateAddButtonState();
    }
  });

  // The initial loadStickers() is handled in checkRoute() now
}

main();
