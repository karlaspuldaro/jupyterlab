// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { BoxLayout, Widget } from '@phosphor/widgets';
import { Kernel } from '@jupyterlab/services';

import { DOMUtils, Toolbar, ToolbarButton } from '@jupyterlab/apputils';

import {
  ABCWidgetFactory,
  DocumentRegistry,
  DocumentWidget,
  IDocumentWidget
} from '@jupyterlab/docregistry';

import {
  CodeEditor,
  IEditorServices,
  IEditorMimeTypeService,
  CodeEditorWrapper
} from '@jupyterlab/codeeditor';

import { PromiseDelegate } from '@phosphor/coreutils';

import { Message } from '@phosphor/messaging';

/**
 * The data attribute added to a widget that can run code.
 */
const CODE_RUNNER = 'jpCodeRunner';

/**
 * The data attribute added to a widget that can undo.
 */
const UNDOER = 'jpUndoer';

/**
 * A code editor wrapper for the file editor.
 */
export class FileEditorCodeWrapper extends CodeEditorWrapper {
  /**
   * Construct a new editor widget.
   */
  constructor(options: FileEditor.IOptions) {
    super({
      factory: options.factory,
      model: options.context.model
    });

    const context = (this._context = options.context);
    const editor = this.editor;

    this.addClass('jp-FileEditorCodeWrapper');
    this.node.dataset[CODE_RUNNER] = 'true';
    this.node.dataset[UNDOER] = 'true';

    editor.model.value.text = context.model.toString();
    void context.ready.then(() => {
      this._onContextReady();
    });

    if (context.model.modelDB.isCollaborative) {
      let modelDB = context.model.modelDB;
      void modelDB.connected.then(() => {
        let collaborators = modelDB.collaborators;
        if (!collaborators) {
          return;
        }

        // Setup the selection style for collaborators
        let localCollaborator = collaborators.localCollaborator;
        this.editor.uuid = localCollaborator.sessionId;

        this.editor.selectionStyle = {
          ...CodeEditor.defaultSelectionStyle,
          color: localCollaborator.color
        };

        collaborators.changed.connect(this._onCollaboratorsChanged, this);
        // Trigger an initial onCollaboratorsChanged event.
        this._onCollaboratorsChanged();
      });
    }
  }

  /**
   * Get the context for the editor widget.
   */
  get context(): DocumentRegistry.Context {
    return this._context;
  }

  /**
   * A promise that resolves when the file editor is ready.
   */
  get ready(): Promise<void> {
    return this._ready.promise;
  }

  /**
   * Handle actions that should be taken when the context is ready.
   */
  private _onContextReady(): void {
    if (this.isDisposed) {
      return;
    }
    const contextModel = this._context.model;
    const editor = this.editor;
    const editorModel = editor.model;

    // Set the editor model value.
    editorModel.value.text = contextModel.toString();

    // Prevent the initial loading from disk from being in the editor history.
    editor.clearHistory();

    // Wire signal connections.
    contextModel.contentChanged.connect(this._onContentChanged, this);

    // Resolve the ready promise.
    this._ready.resolve(undefined);
  }

  /**
   * Handle a change in context model content.
   */
  private _onContentChanged(): void {
    const editorModel = this.editor.model;
    const oldValue = editorModel.value.text;
    const newValue = this._context.model.toString();

    if (oldValue !== newValue) {
      editorModel.value.text = newValue;
    }
  }

  /**
   * Handle a change to the collaborators on the model
   * by updating UI elements associated with them.
   */
  private _onCollaboratorsChanged(): void {
    // If there are selections corresponding to non-collaborators,
    // they are stale and should be removed.
    let collaborators = this._context.model.modelDB.collaborators;
    if (!collaborators) {
      return;
    }
    for (let key of this.editor.model.selections.keys()) {
      if (!collaborators.has(key)) {
        this.editor.model.selections.delete(key);
      }
    }
  }

  protected _context: DocumentRegistry.Context;
  private _ready = new PromiseDelegate<void>();
}

/**
 * A widget for editors.
 */
export class FileEditor extends Widget {
  /**
   * Construct a new editor widget.
   */
  constructor(options: FileEditor.IOptions) {
    super();
    this.addClass('jp-MainAreaWidget');
    this.addClass('jp-FileEditor');
    this.id = DOMUtils.createDomID();

    const context = (this._context = options.context);
    this._mimeTypeService = options.mimeTypeService;

    let editorWidget = (this.editorWidget = new FileEditorCodeWrapper(options));
    this.editor = editorWidget.editor;
    this.model = editorWidget.model;

    // Listen for changes to the path.
    context.pathChanged.connect(this._onPathChanged, this);
    this._onPathChanged();

    let testButton = new ToolbarButton({
      iconClassName: 'fa fa-send',
      label: 'Run code',
      onClick: this.runPython,
      tooltip: 'Test button'
    });

    console.log('Adding toolbar...');
    const toolbar = new Toolbar();

    console.log('Adding toolbar button...');
    toolbar.addItem('test', testButton);

    let layout = (this.layout = new BoxLayout({ spacing: 0 }));
    layout.direction = 'top-to-bottom';
    BoxLayout.setStretch(toolbar, 0);
    BoxLayout.setStretch(editorWidget, 1);
    layout.addWidget(toolbar);
    layout.addWidget(editorWidget);

    if (!editorWidget.id) {
      editorWidget.id = DOMUtils.createDomID();
    }
    editorWidget.node.tabIndex = -1;
  }

  runPython = async () => {
    let model = this.model;
    let code: string = model.value.text;
    console.log('Code: ' + code);

    const kernelSpecs = await this.getKernelSpecs();
    const kernelSettings: Kernel.IOptions = { name: kernelSpecs.default };
    const kernel = await this.startKernel(kernelSettings);
    const future = kernel.requestExecute({ code: code });

    future.onIOPub = msg => {
      if ('name' in msg.content && msg.content.name === 'stdout') {
        let output = msg.content.text;
        console.log('Output:\n' + output);
      }
    };

    future.done.then(() => {
      console.log('Done. Shutting down ' + kernel.name + ' kernel...');
      this.shutDownKernel(kernel);
    });

    // Kernel.getSpecs().then( kernelSpecs => {
    //     console.log('Default spec:', kernelSpecs.default);
    //     console.log('Available specs:', Object.keys(kernelSpecs.kernelspecs));

    //     let options: Kernel.IOptions = { name: kernelSpecs.default };
    //     this.startKernel(code, options);
    // });
  };

  getKernelSpecs = async () => {
    const kernelSpecs = await Kernel.getSpecs();
    console.log('Default spec:', kernelSpecs.default);
    console.log('Available specs:', Object.keys(kernelSpecs.kernelspecs));
    return kernelSpecs;
  };

  startKernel = async (options: Kernel.IOptions) => {
    return Kernel.startNew(options);
  };

  // startKernel = (code:string, options: any) => {
  //   Kernel.startNew(options).then( kernel => {
  //       // Execute and handle replies
  //       const future = kernel.requestExecute({ code: code });
  //       future.done.then(() => {
  //         console.log('Done. Shutting down ' + kernel.name + ' kernel...');
  //         this.shutDownKernel(kernel);
  //       });

  //       future.onIOPub = msg => {
  //         // Print stdout
  //         if ('name' in msg.content && msg.content.name === 'stdout'){
  //           let output = msg.content.text;
  //           console.log('Output:\n' + output);
  //         }
  //       };
  //   });
  // };

  shutDownKernel = (kernel: any) => {
    // Kill the kernel. TODO: need to pass kernel id
    kernel.shutdown().then(() => {
      console.log('Kernel shut down');
    });
  };

  /**
   * Get the context for the editor widget.
   */
  get context(): DocumentRegistry.Context {
    return this.editorWidget.context;
  }

  /**
   * A promise that resolves when the file editor is ready.
   */
  get ready(): Promise<void> {
    return this.editorWidget.ready;
  }

  /**
   * Handle the DOM events for the widget.
   *
   * @param event - The DOM event sent to the widget.
   *
   * #### Notes
   * This method implements the DOM `EventListener` interface and is
   * called in response to events on the widget's node. It should
   * not be called directly by user code.
   */
  handleEvent(event: Event): void {
    if (!this.model) {
      return;
    }
    switch (event.type) {
      case 'mousedown':
        this._ensureFocus();
        break;
      default:
        break;
    }
  }

  /**
   * Handle `after-attach` messages for the widget.
   */
  protected onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    let node = this.node;
    node.addEventListener('mousedown', this);
  }

  /**
   * Handle `before-detach` messages for the widget.
   */
  protected onBeforeDetach(msg: Message): void {
    let node = this.node;
    node.removeEventListener('mousedown', this);
  }

  /**
   * Handle `'activate-request'` messages.
   */
  protected onActivateRequest(msg: Message): void {
    this._ensureFocus();
  }

  /**
   * Ensure that the widget has focus.
   */
  private _ensureFocus(): void {
    if (!this.editor.hasFocus()) {
      this.editor.focus();
    }
  }

  /**
   * Handle a change to the path.
   */
  private _onPathChanged(): void {
    const editor = this.editor;
    const localPath = this._context.localPath;

    editor.model.mimeType = this._mimeTypeService.getMimeTypeByFilePath(
      localPath
    );
  }

  private editorWidget: FileEditorCodeWrapper;
  public model: CodeEditor.IModel;
  public editor: CodeEditor.IEditor;
  protected _context: DocumentRegistry.Context;
  private _mimeTypeService: IEditorMimeTypeService;
}

/**
 * The namespace for editor widget statics.
 */
export namespace FileEditor {
  /**
   * The options used to create an editor widget.
   */
  export interface IOptions {
    /**
     * A code editor factory.
     */
    factory: CodeEditor.Factory;

    /**
     * The mime type service for the editor.
     */
    mimeTypeService: IEditorMimeTypeService;

    /**
     * The document context associated with the editor.
     */
    context: DocumentRegistry.CodeContext;
  }
}

/**
 * A widget factory for editors.
 */
export class FileEditorFactory extends ABCWidgetFactory<
  IDocumentWidget<FileEditor>,
  DocumentRegistry.ICodeModel
> {
  /**
   * Construct a new editor widget factory.
   */
  constructor(options: FileEditorFactory.IOptions) {
    super(options.factoryOptions);
    this._services = options.editorServices;
  }

  /**
   * Create a new widget given a context.
   */
  protected createNewWidget(
    context: DocumentRegistry.CodeContext
  ): IDocumentWidget<FileEditor> {
    let func = this._services.factoryService.newDocumentEditor;
    let factory: CodeEditor.Factory = options => {
      return func(options);
    };
    const content = new FileEditor({
      factory,
      context,
      mimeTypeService: this._services.mimeTypeService
    });
    const widget = new DocumentWidget({ content, context });
    return widget;
  }

  private _services: IEditorServices;
}

/**
 * The namespace for `FileEditorFactory` class statics.
 */
export namespace FileEditorFactory {
  /**
   * The options used to create an editor widget factory.
   */
  export interface IOptions {
    /**
     * The editor services used by the factory.
     */
    editorServices: IEditorServices;

    /**
     * The factory options associated with the factory.
     */
    factoryOptions: DocumentRegistry.IWidgetFactoryOptions<
      IDocumentWidget<FileEditor>
    >;
  }
}
