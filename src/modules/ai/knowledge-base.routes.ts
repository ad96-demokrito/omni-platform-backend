import { NextFunction, Response, Router } from "express";
import multer from "multer";
import { AuthedRequest, requireAuth } from "../../middleware/auth";
import { requireFeature } from "../billing/plan-limits.service";
import { asyncHandler } from "../../middleware/async-handler";
import { KnowledgeBaseService } from "./knowledge-base.service";
import { MAX_DOCUMENT_UPLOAD_BYTES, extractDocumentText } from "./document-extract";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_DOCUMENT_UPLOAD_BYTES, files: 1 },
});

/** Runs multer for a single "file" field and turns its errors into proper 4xx responses. */
function receiveDocumentFile(req: AuthedRequest, res: Response, next: NextFunction) {
  upload.single("file")(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        const maxMb = MAX_DOCUMENT_UPLOAD_BYTES / (1024 * 1024);
        return res.status(413).json({ error: `File is too large. Maximum size is ${maxMb}MB` });
      }
      return res.status(400).json({ error: `Invalid upload: ${err.message}` });
    }
    return next(err);
  });
}

export const knowledgeBaseRouter = Router();
knowledgeBaseRouter.use(requireAuth);
knowledgeBaseRouter.use(requireFeature("ai_copilot"));

// GET /api/knowledge-bases - List all knowledge bases for tenant
knowledgeBaseRouter.get(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const items = await KnowledgeBaseService.listKnowledgeBases(tenantId);
    res.json({ items });
  })
);

// POST /api/knowledge-bases - Create new knowledge base
knowledgeBaseRouter.post(
  "/",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { name, description, system_prompt, provider, model, temperature, is_active, metadata } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    const kb = await KnowledgeBaseService.createKnowledgeBase(tenantId, {
      name,
      description,
      system_prompt,
      provider,
      model,
      temperature,
      is_active,
      metadata,
    });

    res.status(201).json(kb);
  })
);

// GET /api/knowledge-bases/:id - Get single knowledge base
knowledgeBaseRouter.get(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const kb = await KnowledgeBaseService.getKnowledgeBase(tenantId, req.params.id);
    if (!kb) {
      return res.status(404).json({ error: "Knowledge base not found" });
    }
    res.json(kb);
  })
);

// PATCH /api/knowledge-bases/:id - Update knowledge base
knowledgeBaseRouter.patch(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const kb = await KnowledgeBaseService.updateKnowledgeBase(tenantId, req.params.id, req.body);
    if (!kb) {
      return res.status(404).json({ error: "Knowledge base not found" });
    }
    res.json(kb);
  })
);

// DELETE /api/knowledge-bases/:id - Delete knowledge base
knowledgeBaseRouter.delete(
  "/:id",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    await KnowledgeBaseService.deleteKnowledgeBase(tenantId, req.params.id);
    res.json({ success: true });
  })
);

// GET /api/knowledge-bases/:id/documents - List documents
knowledgeBaseRouter.get(
  "/:id/documents",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const docs = await KnowledgeBaseService.listDocuments(tenantId, req.params.id);
    res.json({ items: docs });
  })
);

// POST /api/knowledge-bases/:id/documents - Add document & auto-index
knowledgeBaseRouter.post(
  "/:id/documents",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { title, source_type, source_url, raw_content, metadata } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      return res.status(400).json({ error: "Title is required" });
    }
    if (!raw_content || typeof raw_content !== "string" || !raw_content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }

    const doc = await KnowledgeBaseService.addDocument(tenantId, req.params.id, {
      title,
      source_type: source_type || "text",
      source_url,
      raw_content,
      metadata,
    });

    res.status(201).json(doc);
  })
);

// POST /api/knowledge-bases/:id/documents/upload - Upload a .md/.txt/.pdf file, extract text & auto-index
knowledgeBaseRouter.post(
  "/:id/documents/upload",
  receiveDocumentFile,
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;

    // Verify the KB belongs to this tenant before doing any parsing work
    const kb = await KnowledgeBaseService.getKnowledgeBase(tenantId, req.params.id);
    if (!kb) {
      return res.status(404).json({ error: "Knowledge base not found" });
    }

    const file = (req as AuthedRequest & { file?: Express.Multer.File }).file;
    if (!file) {
      return res.status(400).json({ error: "A file is required (multipart field \"file\")" });
    }

    const extracted = await extractDocumentText(file.buffer, file.originalname, file.mimetype);

    const rawTitle = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const fallbackTitle = file.originalname.replace(/\.[^.]+$/, "");
    const title = (rawTitle || fallbackTitle).slice(0, 200);
    if (!title) {
      return res.status(400).json({ error: "Title is required" });
    }

    // A PDF is always "pdf"; for text files honour the user's choice between markdown and plain text.
    const requestedType = req.body.source_type;
    const sourceType =
      extracted.sourceType !== "pdf" && (requestedType === "markdown" || requestedType === "text")
        ? requestedType
        : extracted.sourceType;

    const doc = await KnowledgeBaseService.addDocument(tenantId, req.params.id, {
      title,
      source_type: sourceType,
      raw_content: extracted.text,
      metadata: {
        filename: file.originalname.slice(0, 255),
        size: file.size,
        mimetype: file.mimetype,
      },
    });

    res.status(201).json(doc);
  })
);

// DELETE /api/knowledge-bases/:id/documents/:docId - Delete document
knowledgeBaseRouter.delete(
  "/:id/documents/:docId",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    await KnowledgeBaseService.deleteDocument(tenantId, req.params.id, req.params.docId);
    res.json({ success: true });
  })
);

// POST /api/knowledge-bases/:id/search - Test similarity chunk search
knowledgeBaseRouter.post(
  "/:id/search",
  asyncHandler(async (req: AuthedRequest, res) => {
    const tenantId = req.auth!.tenantId;
    const { query: queryText, limit } = req.body;

    if (!queryText || typeof queryText !== "string") {
      return res.status(400).json({ error: "Query string is required" });
    }

    const results = await KnowledgeBaseService.searchChunks(
      tenantId,
      req.params.id,
      queryText,
      limit ? parseInt(String(limit), 10) : 5
    );

    res.json({ results });
  })
);
