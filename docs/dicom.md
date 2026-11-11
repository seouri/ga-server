# DICOM studies

`ga import <folder>` imports a DICOM folder (one with a `DICOMDIR` at its top) as imaging studies. GA reads the files itself (no DICOM library, nothing leaves the machine).

## What is read

Each file's header, the first 256 KB only, never the pixels: SOP class and instance, transfer syntax, study and series UIDs and descriptions, study date and time, modality, body part, series and instance numbers.

- One `ImagingStudy` per study UID, with its series and instances (identifier system `urn:dicom:uid`, value `urn:oid:<study UID>`; tag `src-dicom`). `started` is the study date only (DICOM has no time zone); the study time is kept in `description` ("... (study time hh:mm)").
- An Encapsulated PDF object (SOP class `1.2.840.10008.5.1.4.1.1.104.1`, such as a study overview report) is stored as a document (`DocumentReference`, PDF, identified by its SOP instance UID) and linked to its study with `context.related`. It is kept like any imported source file (identifier `urn:ga-server:id:file`): never shared, no `src-dicom` tag, and not listed by `whats_new`.
- No pixel data is stored as a record; the images stay in the archive.

## Transfer syntaxes

Explicit VR little endian, implicit VR little endian, and the compressed (encapsulated) ones, which differ only in pixel data, are read. Explicit VR big endian (`1.2.840.10008.1.2.2`) and deflated (`1.2.840.10008.1.2.1.99`) files are counted as `unsupported` and left out. Undefined-length sequences are skipped.

## Other files

Files that are not DICOM (the `DICOMDIR` index, preview images, `.DS_Store`) are counted as `notDicom` (the engine's `skipped` counts records it left unchanged); they never stop the import.

## Archive

The whole folder is stored once as a tar.gz `DocumentReference` (identifier system `urn:ga-server:id:dicom-archive`, named by the folder's contents). It is never shared (`NEVER_DOCS`): headers carry the patient's name, identifiers and dates. Re-importing the same folder changes nothing (`archive: already-present`).
