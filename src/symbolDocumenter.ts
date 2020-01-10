import * as vscode from 'vscode';
import * as path from 'path';
import regex from './defs_regex';


export const fileGlobPattern = "**/*.{a80,asm,inc,s}";
export const enum DocumenterResult {
	DEFINITION, HOVER, SYMBOL, SYMBOL_FULL
};

export interface SymbolDescriptorExt {
	kind: vscode.SymbolKind;
	declaration: string;
	path: string[];
	location: vscode.Location;
	line: number;
	documentation?: string;
	localLabel: boolean;
	labelPart?: string;
	labelFull?: string;
	context?: vscode.TextDocument;
}

export class SymbolDescriptor implements SymbolDescriptorExt {
	constructor(
		public declaration: string,
		public path: string[],
		public location: vscode.Location,
		public line = location.range.start.line,
		public documentation?: string,
		public kind: vscode.SymbolKind = vscode.SymbolKind.Variable,
		public localLabel: boolean = false) {}
}

class IncludeDescriptor {
	constructor(
		public declaration: string,
		public labelPath: string[],
		public fullPath: string,
		public location: vscode.Location,
		public line = location.range.start.line) {}
}

class FileTable {
	includes: IncludeDescriptor[] = [];
	symbols: SymbolDescriptor[] = [];
}

type SymbolDocumenterMultitype =
	vscode.Definition | vscode.Hover | SymbolDescriptorExt;

export type SymbolMap = { [name: string]: SymbolDescriptor };

export class ASMSymbolDocumenter {
	private _watcher: vscode.FileSystemWatcher;

	files: { [name: string]: FileTable } = {};


	constructor() {
		const fileUriHandler = ((uri: vscode.Uri) => {
			vscode.workspace.openTextDocument(uri).then(doc => this._document(doc));
		});

		vscode.workspace
			.findFiles(fileGlobPattern)
			.then(files => files.forEach(fileUriHandler));

		vscode.workspace.onDidChangeTextDocument(
			(event: vscode.TextDocumentChangeEvent) => this._document(event.document)
		);

		this._watcher = vscode.workspace.createFileSystemWatcher(fileGlobPattern);
		this._watcher.onDidChange(fileUriHandler);
		this._watcher.onDidCreate(fileUriHandler);
		this._watcher.onDidDelete((uri) => {
			delete this.files[uri.fsPath];
		});
	}

	destroy() {
		this._watcher.dispose();
	}

	/**
	 * Seeks symbols for use by Intellisense in the file at `fsPath`.
	 * @param fsPath The path of the file to seek in.
	 * @param output The collection of discovered symbols.
	 * @param searched Paths of files that have already been searched.
	 * @param searchIncludes If true, also searches file includes.
	 */
	private async _seekSymbols(fsPath: string, output: SymbolMap,
				prependPath: string[] = [], searched: string[] = []) {

		let table = this.files[fsPath];

		if (!table) {
			// Open missing document and process...
			const doc = await vscode.workspace.openTextDocument(fsPath);

			this._document(doc);
			table = this.files[fsPath];
		}

		searched.push(fsPath);

		for (const symbol of table.symbols) {
			const fullPath = [ ...prependPath, ...symbol.path ];

			for (let i = fullPath.length - 1; i >= 0; i--) {
				const name = fullPath.slice(i).join('.').replace('..', '.');

				if (!(name in output)) {
					output[name] = symbol;
				}
			}
		}

		await Promise.all(table.includes.map(async include => {
			if (searched.indexOf(include.fullPath) == -1) {
				await this._seekSymbols(include.fullPath, output, include.labelPath, searched);
			}
		}));
	}

	/**
	 * Returns an include descriptor within scope of `context` on given `line`.
	 * @param context The document to find symbols for.
	 * @param declaration relative path
	 * @param line
	 */
	private _getInclude(context: vscode.TextDocument, declaration: string, line: number) {
		const fsPath = context.uri.fsPath;
		const table = this.files[fsPath];

		if (table) {
			const include = table.includes.find(i => (i.declaration === declaration && i.line === line));

			if (include) {
				const doc = vscode.Uri.file(include.fullPath);
				const range = new vscode.Range(0, 0, 0, 0);

				return {
					...include,
					destLocation: new vscode.Location(doc, range)
				};
			}
		}

		return null;
	}

	/**
	 * Get file uri list for given document including all its
	 * included files recursively.
	 * @param {vscode.TextDocument} doc
	 */
	filesWithIncludes(context: vscode.TextDocument) {
		const fsPath = context.uri.fsPath;
		const table = this.files[fsPath];

		const result: { [name: string]: IncludeDescriptor } = {};
		const putAllToResults = (t: FileTable): any => t?.includes
			.filter(i => (!result[i.fullPath]) && (result[i.fullPath] = i) && true)
			.forEach(i => putAllToResults(this.files[i.fullPath]));

		if (table) {
			result[fsPath] = <any> {
				declaration: context.fileName,
				fullPath: fsPath,
				labelPath: []
			};

			putAllToResults(table);
		}

		return result;
	}

	/**
	 * Returns a set of symbols possibly within scope of `context`.
	 * @param context The document to find symbols for.
	 */
	async symbols(context: vscode.TextDocument): Promise<SymbolMap> {
		const output: SymbolMap = {};
		const searched: string[] = [];

		await this._seekSymbols(context.uri.fsPath, output, [], searched);

		for (const filepath in this.files) {
			if (searched.length && !searched.includes(filepath)) {
				await this._seekSymbols(filepath, output, [], searched);
			}
		}

		return output;
	}

	/**
	 * Provide a list of symbols for both 'Go to Symbol in...' functions.
	 * @param fileFilter (optional) URI of specific file in workspace.
	 * @param query (optional) Part of string to find in symbol name.
	 * @param token Cancellation token object.
	 * @returns Promise of SymbolInformation objects array.
	 */
	provideSymbols (
		fileFilter: string | null,
		query: string | null,
		token: vscode.CancellationToken
	): Promise<vscode.SymbolInformation[]> {

		return new Promise<vscode.SymbolInformation[]>((resolve, reject) => {
			if (token.isCancellationRequested) {
				reject();
			}

			const output: vscode.SymbolInformation[] = [];

			for (const fileName in this.files) {
				if (!fileFilter || fileFilter === fileName) {
					const table = this.files[fileName];

					table.symbols.forEach(symbol => {
						if (!query || ~symbol.declaration.indexOf(query)) {
							output.push(new vscode.SymbolInformation(
								symbol.declaration, symbol.kind,
								symbol.location.range, symbol.location.uri
							));
						}
					});
				}
			}

			if (output.length > 0) {
				resolve(output);
			}

			reject();
		});
	}

	/**
	 * Provide defined symbol for 'Go to Definition' or symbol hovering.
	 * @param context Text document object.
	 * @param position Cursor position.
	 * @param token Cancellation token object.
	 * @param hoverDocumentation Provide a hover object.
	 * @returns Promise of T.
	 */
	getFullSymbolAtDocPosition<T = SymbolDocumenterMultitype> (
		context: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		resultType: DocumenterResult = DocumenterResult.DEFINITION): Promise<T> {

		return (async () => {
			const lineText = context.lineAt(position.line).text;
			const includeLineMatch = regex.includeLine.exec(lineText);

			if (resultType < DocumenterResult.SYMBOL && includeLineMatch) {
				const include = this._getInclude(context, includeLineMatch[4], position.line);

				if (include) {
					if (position.character >= include.location.range.start.character &&
						position.character <= include.location.range.end.character) {

						if (resultType === DocumenterResult.HOVER) {
							return new vscode.Hover(include.fullPath, include.location.range);
						}
						else {
							return include.destLocation;
						}
					}
				}
				else {
					return;
				}
			}

			const commentLineMatch = regex.endComment.exec(lineText);
			if (commentLineMatch && position.character >= commentLineMatch.index) {
				return;
			}

			let range = context.getWordRangeAtPosition(position, regex.stringBounds);
			if (range && !range.isEmpty) {
				return;
			}

			range = context.getWordRangeAtPosition(position, regex.numerals);
			if (range && !range.isEmpty) {
				return;
			}

			if (resultType === DocumenterResult.SYMBOL) {
				range = context.getWordRangeAtPosition(position);
			}
			else {
				range = context.getWordRangeAtPosition(position, regex.fullLabel);
			}

			if (!range || (range && (range.isEmpty || !range.isSingleLine))) {
				return;
			}

			if (resultType < DocumenterResult.SYMBOL) {
				const activeLinePart = lineText.substr(0, range.end.character);
				const keywordMatch = regex.shouldSuggestInstruction.exec(activeLinePart);

				const arg1RegisterMatch = regex.shouldSuggest1ArgRegister.exec(activeLinePart);
				const arg2RegisterMatch = regex.shouldSuggest2ArgRegister.exec(activeLinePart);
				const condFlagsMatch = regex.condFlags.exec(activeLinePart);

				if ((condFlagsMatch && condFlagsMatch[2]) ||
					(keywordMatch && keywordMatch[4] &&
						regex.keyword.test(keywordMatch[4])) ||
					(arg2RegisterMatch && arg2RegisterMatch[3] &&
						regex.registers.test(arg2RegisterMatch[3])) ||
					(arg1RegisterMatch && arg1RegisterMatch[4] &&
						regex.registers.test(arg1RegisterMatch[4]))) {

					return;
				}
			}

			const symbols = await this.symbols(context);
			if (token.isCancellationRequested) {
				return;
			}

			let lbPart = context.getText(range);
			let lbFull = lbPart;
			let lbParent: string | undefined = undefined;
			let lbModule: string | undefined = undefined;

			if (resultType === DocumenterResult.SYMBOL_FULL && lbPart[0] !== '.') {
				const lbSplitted = lbFull.split('.');
				if (lbSplitted.length >= 2) {
					let testLb = symbols[lbSplitted[0]];
					if (testLb) {
						if (testLb.kind === vscode.SymbolKind.Module) {
							lbModule = lbSplitted.shift();
							if (lbSplitted.length > 1) {
								lbParent = lbSplitted.shift();
							}

							lbFull = lbPart = lbSplitted[0];
						}
						else {
							lbParent = lbSplitted.shift();
							lbFull = lbPart = `.${lbSplitted[0]}`;
						}
					}
				}
			}

			if (!lbParent && !lbModule) {
				for (let lineNumber = position.line - 1; lineNumber >= 0; lineNumber--) {
					let line = context.lineAt(lineNumber);
					if (line.isEmptyOrWhitespace) {
						continue;
					}
					if (lbPart[0] === '.' && !lbParent) {
						const parentLabelMatch = line.text.match(regex.parentLabel);
						if (parentLabelMatch) {
							lbParent = parentLabelMatch[1];
						}
					}
					const moduleLineMatch = line.text.match(regex.moduleLine);
					if (moduleLineMatch) {
						lbModule = moduleLineMatch[2];
						break;
					}
					else if (regex.endmoduleLine.test(line.text)) {
						break;
					}
				}
			}

			lbFull = this._enlargeLabel(this._enlargeLabel(lbFull, lbParent), lbModule);

			const symbol: any = symbols[lbFull] || symbols[lbPart];
			if (!symbol) {
				return;
			}

			if (resultType === DocumenterResult.HOVER) {
				return new vscode.Hover(new vscode.MarkdownString(symbol.documentation), range);
			}
			else if (resultType === DocumenterResult.DEFINITION) {
				return symbol.location;
			}
			else if (resultType >= DocumenterResult.SYMBOL) {
				symbol.context = context;
				symbol.labelPart = lbPart;
				symbol.labelFull = lbFull;

				return symbol;
			}
		})();
	}

	private _enlargeLabel(base: string, prepend?: string): string {
		if (prepend && base.indexOf(prepend) < 0) {
			if (base[0] === '.') {
				base = prepend + base;
			}
			else {
				base = `${prepend}.${base}`;
			}
		}
		return base;
	}

	private _document(document: vscode.TextDocument) {
		const table = new FileTable();
		this.files[document.uri.fsPath] = table;

		let moduleStack: string[] = [];
		let commentBuffer: string[] = [];
		let lastFullLabel: string | null = null;

		for (let lineNumber = 0; lineNumber < document.lineCount; lineNumber++) {
			const line = document.lineAt(lineNumber);
			if (line.isEmptyOrWhitespace) {
				continue;
			}

			const commentLineMatch = regex.commentLine.exec(line.text);
			if (commentLineMatch) {
				const baseLine = commentLineMatch[1].trim();

				if (regex.horizontalRule.test(baseLine)) {
					continue;
				}

				commentBuffer.push(baseLine);
			}
			else {
				const includeLineMatch = regex.includeLine.exec(line.text);
				const moduleLineMatch = regex.moduleLine.exec(line.text);
				const macroLineMatch = regex.macroLine.exec(line.text);
				const labelMatch = regex.labelDefinition.exec(line.text);
				let labelPath = [];

				if (labelMatch) {
					labelPath.push(labelMatch[1]);

					let localLabel: boolean = false;
					let declaration = labelMatch[1];
					if (declaration[0] === '.') {
						localLabel = true;

						if (lastFullLabel) {
							labelPath.unshift(lastFullLabel);
							declaration = lastFullLabel + declaration;
						}
					}
					else if (declaration.indexOf('$$') < 0) {
						lastFullLabel = declaration;
					}

					if (moduleStack.length && labelMatch[0][0] !== '@') {
						labelPath.unshift(moduleStack[0]);
						declaration = `${moduleStack[0]}.${declaration}`;
					}

					const location = new vscode.Location(document.uri, line.range.start);
					const defineExpressionMatch = regex.defineExpression.exec(line.text);
					const evalExpressionMatch = regex.evalExpression.exec(line.text);
					const endCommentMatch = regex.endComment.exec(line.text);

					if (defineExpressionMatch) {
						let instruction = (defineExpressionMatch[2] + " ".repeat(8)).substr(0, 8);
						commentBuffer.push("\n```\n" + instruction + defineExpressionMatch[3].trim() + "\n```");
					}
					else if (evalExpressionMatch) {
						commentBuffer.push("\n`" + evalExpressionMatch[3].trim() + "`");
					}

					if (endCommentMatch) {
						commentBuffer.unshift(endCommentMatch[1].trim());
					}

					table.symbols.push(new SymbolDescriptor(
						declaration,
						labelPath,
						location,
						lineNumber,
						commentBuffer.join("\n").trim() || undefined,
						vscode.SymbolKind.Variable,
						localLabel
					));
				}

				const pathFragment = [  ...moduleStack.slice(0, 1), ...labelPath.slice(-1) ];

				if (includeLineMatch) {
					const filename = includeLineMatch[4];
					const documentDirname = path.dirname(document.uri.fsPath);
					const includeName = path.join(documentDirname, filename);

					let pos = includeLineMatch.index + includeLineMatch[1].length;
					const linePos1 = new vscode.Position(lineNumber, pos);

					pos += includeLineMatch[2].length;
					const linePos2 = new vscode.Position(lineNumber, pos);

					const range = new vscode.Range(linePos1, linePos2);
					const location = new vscode.Location(document.uri, range);

					table.includes.push(new IncludeDescriptor(
						filename,
						pathFragment,
						includeName,
						location,
						lineNumber
					));
				}
				else if (macroLineMatch) {
					const declaration = macroLineMatch[2];
					const start = line.firstNonWhitespaceCharacterIndex + macroLineMatch[1].length;
					const location = new vscode.Location(document.uri, new vscode.Range(
						line.lineNumber, start,
						line.lineNumber, start + declaration.length
					));

					const endCommentMatch = regex.endComment.exec(line.text);
					if (endCommentMatch) {
						commentBuffer.unshift(endCommentMatch[1].trim());
					}

					if (macroLineMatch[3]) {
						commentBuffer.unshift("\`" + macroLineMatch[3].trim() + "`\n");
					}

					commentBuffer.unshift(`**macro ${declaration}**`);
					pathFragment.push(declaration);

					table.symbols.push(new SymbolDescriptor(
						declaration,
						pathFragment,
						location,
						lineNumber,
						commentBuffer.join("\n").trim(),
						vscode.SymbolKind.Function
					));
				}
				else if (moduleLineMatch) {
					const declaration = moduleLineMatch[2];
					const start = line.firstNonWhitespaceCharacterIndex + moduleLineMatch[1].length;
					const location = new vscode.Location(document.uri, new vscode.Range(
						line.lineNumber, start,
						line.lineNumber, start + declaration.length
					));

					moduleStack.unshift(declaration);
					commentBuffer.unshift(`**module ${declaration}**\n`);
					pathFragment.push(declaration);

					table.symbols.push(new SymbolDescriptor(
						declaration,
						pathFragment,
						location,
						lineNumber,
						commentBuffer.join("\n").trim(),
						vscode.SymbolKind.Module
					));
				}
				else if (regex.endmoduleLine.test(line.text)) {
					moduleStack.shift();
				}

				commentBuffer = [];
			}
		}
	}
}
