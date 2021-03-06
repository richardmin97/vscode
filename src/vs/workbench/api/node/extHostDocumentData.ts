/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import { regExpLeadsToEndlessLoop } from 'vs/base/common/strings';
import { MirrorModel2 } from 'vs/editor/common/model/mirrorModel2';
import URI from 'vs/base/common/uri';
import { Range, Position } from 'vs/workbench/api/node/extHostTypes';
import * as vscode from 'vscode';
import { getWordAtText, ensureValidWordDefinition } from 'vs/editor/common/model/wordHelper';
import { MainThreadDocumentsShape } from './extHost.protocol';
import { ITextSource } from 'vs/editor/common/model/textSource';

const _modeId2WordDefinition = new Map<string, RegExp>();
export function setWordDefinitionFor(modeId: string, wordDefinition: RegExp): void {
	_modeId2WordDefinition.set(modeId, wordDefinition);
}
export function getWordDefinitionFor(modeId: string): RegExp {
	return _modeId2WordDefinition.get(modeId);
}

export class ExtHostDocumentData extends MirrorModel2 {

	private _proxy: MainThreadDocumentsShape;
	private _languageId: string;
	private _isDirty: boolean;
	private _textLines: vscode.TextLine[];
	private _document: vscode.TextDocument;

	constructor(proxy: MainThreadDocumentsShape, uri: URI, lines: string[], eol: string,
		languageId: string, versionId: number, isDirty: boolean) {

		super(uri, lines, eol, versionId);
		this._proxy = proxy;
		this._languageId = languageId;
		this._isDirty = isDirty;
		this._textLines = [];
	}

	dispose(): void {
		this._textLines.length = 0;
		this._isDirty = false;
		super.dispose();
	}

	equalLines({ lines }: ITextSource): boolean {
		const len = lines.length;
		if (len !== this._lines.length) {
			return false;
		}
		for (let i = 0; i < len; i++) {
			if (lines[i] !== this._lines[i]) {
				return false;
			}
		}
		return true;
	}

	get document(): vscode.TextDocument {
		if (!this._document) {
			const data = this;
			this._document = {
				get uri() { return data._uri; },
				get fileName() { return data._uri.fsPath; },
				get isUntitled() { return data._uri.scheme !== 'file'; },
				get languageId() { return data._languageId; },
				get version() { return data._versionId; },
				get isDirty() { return data._isDirty; },
				save() { return data._proxy.$trySaveDocument(data._uri); },
				getText(range?) { return range ? data._getTextInRange(range) : data.getText(); },
				get lineCount() { return data._lines.length; },
				lineAt(lineOrPos) { return data.lineAt(lineOrPos); },
				offsetAt(pos) { return data.offsetAt(pos); },
				positionAt(offset) { return data.positionAt(offset); },
				validateRange(ran) { return data.validateRange(ran); },
				validatePosition(pos) { return data.validatePosition(pos); },
				getWordRangeAtPosition(pos, regexp?) { return data.getWordRangeAtPosition(pos, regexp); }
			};
		}
		return this._document;
	}

	_acceptLanguageId(newLanguageId: string): void {
		this._languageId = newLanguageId;
	}

	_acceptIsDirty(isDirty: boolean): void {
		this._isDirty = isDirty;
	}

	private _getTextInRange(_range: vscode.Range): string {
		let range = this.validateRange(_range);

		if (range.isEmpty) {
			return '';
		}

		if (range.isSingleLine) {
			return this._lines[range.start.line].substring(range.start.character, range.end.character);
		}

		let lineEnding = this._eol,
			startLineIndex = range.start.line,
			endLineIndex = range.end.line,
			resultLines: string[] = [];

		resultLines.push(this._lines[startLineIndex].substring(range.start.character));
		for (let i = startLineIndex + 1; i < endLineIndex; i++) {
			resultLines.push(this._lines[i]);
		}
		resultLines.push(this._lines[endLineIndex].substring(0, range.end.character));

		return resultLines.join(lineEnding);
	}

	lineAt(lineOrPosition: number | vscode.Position): vscode.TextLine {

		let line: number;
		if (lineOrPosition instanceof Position) {
			line = lineOrPosition.line;
		} else if (typeof lineOrPosition === 'number') {
			line = lineOrPosition;
		}

		if (line < 0 || line >= this._lines.length) {
			throw new Error('Illegal value for `line`');
		}

		let result = this._textLines[line];
		if (!result || result.lineNumber !== line || result.text !== this._lines[line]) {

			const text = this._lines[line];
			const firstNonWhitespaceCharacterIndex = /^(\s*)/.exec(text)[1].length;
			const range = new Range(line, 0, line, text.length);
			const rangeIncludingLineBreak = line < this._lines.length - 1
				? new Range(line, 0, line + 1, 0)
				: range;

			result = Object.freeze({
				lineNumber: line,
				range,
				rangeIncludingLineBreak,
				text,
				firstNonWhitespaceCharacterIndex, //TODO@api, rename to 'leadingWhitespaceLength'
				isEmptyOrWhitespace: firstNonWhitespaceCharacterIndex === text.length
			});

			this._textLines[line] = result;
		}

		return result;
	}

	offsetAt(position: vscode.Position): number {
		position = this.validatePosition(position);
		this._ensureLineStarts();
		return this._lineStarts.getAccumulatedValue(position.line - 1) + position.character;
	}

	positionAt(offset: number): vscode.Position {
		offset = Math.floor(offset);
		offset = Math.max(0, offset);

		this._ensureLineStarts();
		let out = this._lineStarts.getIndexOf(offset);

		let lineLength = this._lines[out.index].length;

		// Ensure we return a valid position
		return new Position(out.index, Math.min(out.remainder, lineLength));
	}

	// ---- range math

	validateRange(range: vscode.Range): vscode.Range {
		if (!(range instanceof Range)) {
			throw new Error('Invalid argument');
		}

		let start = this.validatePosition(range.start);
		let end = this.validatePosition(range.end);

		if (start === range.start && end === range.end) {
			return range;
		}
		return new Range(start.line, start.character, end.line, end.character);
	}

	validatePosition(position: vscode.Position): vscode.Position {
		if (!(position instanceof Position)) {
			throw new Error('Invalid argument');
		}

		let { line, character } = position;
		let hasChanged = false;

		if (line < 0) {
			line = 0;
			character = 0;
			hasChanged = true;
		}
		else if (line >= this._lines.length) {
			line = this._lines.length - 1;
			character = this._lines[line].length;
			hasChanged = true;
		}
		else {
			let maxCharacter = this._lines[line].length;
			if (character < 0) {
				character = 0;
				hasChanged = true;
			}
			else if (character > maxCharacter) {
				character = maxCharacter;
				hasChanged = true;
			}
		}

		if (!hasChanged) {
			return position;
		}
		return new Position(line, character);
	}

	getWordRangeAtPosition(_position: vscode.Position, regexp?: RegExp): vscode.Range {
		let position = this.validatePosition(_position);
		if (!regexp || regExpLeadsToEndlessLoop(regexp)) {
			regexp = getWordDefinitionFor(this._languageId);
		}
		let wordAtText = getWordAtText(
			position.character + 1,
			ensureValidWordDefinition(regexp),
			this._lines[position.line],
			0
		);

		if (wordAtText) {
			return new Range(position.line, wordAtText.startColumn - 1, position.line, wordAtText.endColumn - 1);
		}
		return undefined;
	}
}
