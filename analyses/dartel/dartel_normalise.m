function dartel_normalise(work, listfile, spmdir)
% SPM 25 DARTEL "Normalise to MNI Space" for every participant in listfile:
% each native tissue class is warped with the participant's flow field and
% the Template_6 -> MNI affine to a 1.5 mm grid.
%
% The default bounding box ends at MNI z = -72, while brainstem white matter
% continues below it and the template reaches about z = -85, so the grid is
% extended to z = -84 (x -90 to 90, y -126 to 90, z -84 to 108).
% (a) c1 and c2, modulated (preserve amount), FWHM 0 -> <work>/mni_zext/fwhm0/mwc*.
% (b) c2, modulated, FWHM 8 mm -> <work>/mni_zext/fwhm8/smwc2* (voxelwise analysis).
% (c) A field-of-view image (ones on the native grid of c1), unmodulated,
%     FWHM 0 -> <work>/mni_zext/fov/wfov*, for the region coverage check.
addpath(spmdir); spm('defaults', 'PET'); spm_jobman('initcfg'); spm_get_defaults('cmdline', true);
addpath(fullfile(spmdir, 'toolbox', 'DARTEL'));
sids = strtrim(splitlines(fileread(listfile))); sids = sids(~cellfun(@isempty, sids));
tmpl = fullfile(work, 'dartel', 'DartelTemplates', 'Template_6.nii');
% Template scans carry the flow field from template creation; the others the
% one from dartel_warp.
u  = cellfun(@(s) fullfile(work, 'dartel', s, ['u_rc1' s '_T1w_Template.nii']), sids, 'UniformOutput', false);
for q = 1:numel(u)
    if exist(u{q}, 'file') ~= 2, u{q} = fullfile(work, 'dartel', sids{q}, ['u_rc1' sids{q} '_T1w.nii']); end
end
c1 = cellfun(@(s) fullfile(work, 'seg', s, ['c1' s '_T1w.nii']), sids, 'UniformOutput', false);
c2 = cellfun(@(s) fullfile(work, 'seg', s, ['c2' s '_T1w.nii']), sids, 'UniformOutput', false);
assert(all(cellfun(@(f) exist(f, 'file') == 2, [{tmpl}; u; c1; c2])), 'DARTEL inputs are missing');
bb = [-90 -126 -84; 90 90 108];
write_mni(tmpl, u, {c1, c2}, bb, 1, 0, fullfile(work, 'mni_zext', 'fwhm0'));
write_mni(tmpl, u, {c2}, bb, 1, 8, fullfile(work, 'mni_zext', 'fwhm8'));
fov = cell(size(sids));
for q = 1:numel(sids)
    V = spm_vol(c1{q});
    if isfield(V, 'private'), V = rmfield(V, 'private'); end
    V.fname = fullfile(work, 'seg', sids{q}, ['fov' sids{q} '_T1w.nii']);
    V.dt = [spm_type('float32') spm_platform('bigend')]; V.pinfo = [1; 0; 0];
    spm_write_vol(V, ones(V.dim, 'single'));
    fov{q} = V.fname;
end
write_mni(tmpl, u, {fov}, bb, 0, 0, fullfile(work, 'mni_zext', 'fov'));
end

function write_mni(tmpl, u, images, bb, preserve, fwhm, outdir)
if ~exist(outdir, 'dir'), mkdir(outdir); end
t0 = tic;
job = struct();
job.template = {tmpl};
job.data.subjs.flowfields = u;
job.data.subjs.images = images;
job.vox = [1.5 1.5 1.5];
job.bb = bb;
job.preserve = preserve;
job.fwhm = [fwhm fwhm fwhm];
job.output = struct('option', 'allin', 'outDir', outdir);
spm_dartel_norm_fun(job);
fprintf('Normalised %d participants to %s in %.1f s.\n', numel(u), outdir, toc(t0));
end
